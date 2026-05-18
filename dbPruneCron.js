#!/usr/bin/env node

// Cap DB pool before any module loads ./db. Cron does sequential VACUUM/
// DELETE work; 2 connections is plenty and keeps it from starving the API.
process.env.DB_POOL_MAX = "2";

/**
 * dbPruneCron.js — Weekly database pruning cron
 *
 * Deletes old, low-value data to keep Postgres lean:
 *
 * 1. keyword_daily_stats — purge rows with junk dates or older than 30 days
 *    (was 90 days — tightened 2026-05-15 because daily volume of ~1.8M rows
 *     meant 90-day retention accumulated 168M rows / 37GB; 30 days keeps
 *     trend charts intact for the periods users actually look at)
 * 2. news_articles — delete articles older than 45 days UNLESS they:
 *    a) belong to a story thread (story_thread_articles)
 *    b) belong to a story timeline (story_timeline_articles)
 *    c) are from a tier-4 source (kept indefinitely — these are the hourly-
 *       fetched top sources, worth keeping as a long archive)
 *    d) are videos (media_type = 'video' — YouTube articles + other video
 *       content live on a separate ingest pipeline and are valuable
 *       regardless of source tier)
 *    Tightened 2026-05-18: dropped base_priority>=5 and tier>=2 +
 *    priority>=3 carve-outs. The DB was accumulating ~95k articles/day;
 *    the relaxed rule kept too much low-value noise from tier 1/2/3 RSS
 *    sources. Threads/timelines are the canonical "this matters" signal;
 *    anything else from a non-tier-4 RSS source is background volume.
 *    Child rows (article_keywords, article_locations, article_tags,
 *    article_image_assignments, article_entities, article_entity_mentions,
 *    article_referenced_dates, article_entity_extraction_state, image_usage_log)
 *    cascade or are deleted explicitly.
 * 3. article_keywords — table-bloat cleanup (folded in 2026-05-18 from
 *    the standalone pruneKeywords.js so the weekly cron handles ALL old
 *    junk in one pass). Deletes:
 *      a) orphans where article_id no longer exists (safety net for
 *         articles deleted via other paths)
 *      b) pure-numeric keywords (years, counts — no semantic signal)
 *      c) keywords shorter than 3 chars ("the", "and", etc. — noise)
 *      d) rows with frequency <= 1 (single-mention, low signal)
 *      e) keywords appearing in < 2 articles globally (singletons —
 *         can't possibly cluster anything by Jaccard)
 *      f) per-article tail: keep only the top 15 keywords by frequency
 *         (everything past 15 is by definition tail noise)
 *    pruneKeywords.js still exists as a standalone --analyze tool.
 * 4. image_usage_log — prune entries older than 14 days
 *    (was 60 days — tightened 2026-05-15; this is just impression
 *     telemetry, doesn't need long retention)
 * 5. rss_error_logs — prune entries older than 30 days
 * 6. briefing_episodes — REINDEX to fix bloated indexes
 *
 * Runs as a child process (calls pool.end() on completion).
 * Spawn via: node dbPruneCron.js
 */

require("dotenv").config();
const pool = require("./db");

const TAG = "[dbPrune]";
const DRY_RUN = process.argv.includes("--dry-run");

async function log(msg) { console.log(`${TAG} ${msg}`); }

async function run() {
  const t0 = Date.now();
  log(`Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // ─── 1. keyword_daily_stats: purge junk dates + old data ────────────────
  log("Phase 1: keyword_daily_stats cleanup...");
  if (!DRY_RUN) {
    // Delete in batches to avoid long-running locks
    let totalKds = 0;
    let batch;
    do {
      const { rowCount } = await pool.query(`
        DELETE FROM keyword_daily_stats
        WHERE ctid IN (
          SELECT ctid FROM keyword_daily_stats
          WHERE date < CURRENT_DATE - INTERVAL '30 days'
             OR date > CURRENT_DATE + INTERVAL '7 days'
          LIMIT 50000
        )
      `);
      batch = rowCount;
      totalKds += batch;
      if (batch > 0) log(`  ...deleted batch of ${batch} keyword_daily_stats rows`);
    } while (batch >= 50000);
    log(`  Total keyword_daily_stats purged: ${totalKds.toLocaleString()} rows`);
  } else {
    const { rows: [{ count }] } = await pool.query(`
      SELECT COUNT(*) AS count FROM keyword_daily_stats
      WHERE date < CURRENT_DATE - INTERVAL '30 days'
         OR date > CURRENT_DATE + INTERVAL '7 days'
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} keyword_daily_stats rows`);
  }

  // ─── 2. news_articles: purge old low-value articles ─────────────────────
  log("Phase 2: old article cleanup...");

  // Identify articles to KEEP (threads, timelines, high-score, videos, good tier sources)
  // Then delete everything else older than 90 days.
  // Use a temp table approach for efficiency on large sets.
  if (!DRY_RUN) {
    // Step 2a: Explicitly delete non-cascading child tables first
    // article_keywords, article_locations, article_tags don't have ON DELETE CASCADE
    // (they were created before cascades were standard in this project)
    const childTables = [
      'article_keywords',
      'article_locations',
      'article_tags',
    ];

    // Count candidates first
    const { rows: [{ count: candidateCount }] } = await pool.query(`
      SELECT COUNT(*) AS count
      FROM news_articles a
      WHERE a.published_at < NOW() - INTERVAL '45 days'
        AND (a.media_type IS NULL OR a.media_type != 'video')
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM news_sources ns
          WHERE ns.id = a.source_id AND ns.fetch_tier = 4
        )
    `);
    log(`  Found ${Number(candidateCount).toLocaleString()} articles eligible for deletion`);

    if (Number(candidateCount) > 0) {
      // Create a temp table of article IDs to delete
      await pool.query(`
        CREATE TEMP TABLE _prune_article_ids AS
        SELECT a.id
        FROM news_articles a
        WHERE a.published_at < NOW() - INTERVAL '45 days'
          AND NOT EXISTS (
            SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM news_sources ns
            WHERE ns.id = a.source_id AND ns.fetch_tier = 4
          )
      `);

      // Delete child rows in batches
      for (const table of childTables) {
        let totalChild = 0;
        let batch;
        do {
          const { rowCount } = await pool.query(`
            DELETE FROM ${table}
            WHERE article_id IN (
              SELECT id FROM _prune_article_ids LIMIT 10000
            )
            AND ctid IN (
              SELECT ctid FROM ${table}
              WHERE article_id IN (
                SELECT id FROM _prune_article_ids LIMIT 10000
              )
              LIMIT 50000
            )
          `);
          batch = rowCount;
          totalChild += batch;
          if (batch > 0) log(`  ...deleted batch of ${batch} ${table} rows`);
        } while (batch >= 50000);
        log(`  Total ${table} purged: ${totalChild.toLocaleString()} rows`);
      }

      // Now delete the articles themselves (cascading tables handle themselves)
      let totalArticles = 0;
      let batch2;
      do {
        const { rowCount } = await pool.query(`
          DELETE FROM news_articles
          WHERE id IN (
            SELECT id FROM _prune_article_ids LIMIT 5000
          )
        `);
        batch2 = rowCount;
        totalArticles += batch2;
        // Remove deleted IDs from temp table
        if (batch2 > 0) {
          await pool.query(`
            DELETE FROM _prune_article_ids
            WHERE id IN (
              SELECT id FROM _prune_article_ids LIMIT 5000
            )
          `);
          log(`  ...deleted batch of ${batch2} news_articles rows`);
        }
      } while (batch2 >= 5000);
      log(`  Total news_articles purged: ${totalArticles.toLocaleString()} rows`);

      await pool.query(`DROP TABLE IF EXISTS _prune_article_ids`);
    }
  } else {
    const { rows: [{ count }] } = await pool.query(`
      SELECT COUNT(*) AS count
      FROM news_articles a
      WHERE a.published_at < NOW() - INTERVAL '45 days'
        AND (a.media_type IS NULL OR a.media_type != 'video')
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM news_sources ns
          WHERE ns.id = a.source_id AND ns.fetch_tier = 4
        )
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} articles + child rows`);
  }

  // ─── 3. article_keywords: table-bloat cleanup ──────────────────────────
  log("Phase 3: article_keywords cleanup...");
  // Rules below are the same as the standalone pruneKeywords.js, folded in
  // here so the weekly cron handles everything in one pass.
  // Some rules seq-scan a 90M+ row table (no index on frequency/length/
  // regex). Bump the session-level statement_timeout so they don't get
  // killed mid-DELETE by the pool's default 45s.
  await pool.query(`SET statement_timeout = '30min'`);
  const KW_MIN_LEN = 3;
  const KW_MIN_FREQ = 1;
  const KW_MIN_GLOBAL = 2;
  const KW_MAX_PER_ARTICLE = 15;
  const KW_BATCH = 10000;

  if (!DRY_RUN) {
    // 3a. orphans (article gone, keyword left behind)
    const { rowCount: kw0 } = await pool.query(`
      DELETE FROM article_keywords
       WHERE article_id NOT IN (SELECT id FROM news_articles)
    `);
    log(`  3a orphans (article missing): ${kw0.toLocaleString()} rows`);

    // 3b. pure-numeric keywords
    const { rowCount: kw1 } = await pool.query(`
      DELETE FROM article_keywords WHERE keyword ~ '^[0-9]+$'
    `);
    log(`  3b pure numeric: ${kw1.toLocaleString()} rows`);

    // 3c. short keywords
    const { rowCount: kw2 } = await pool.query(`
      DELETE FROM article_keywords WHERE LENGTH(keyword) < $1
    `, [KW_MIN_LEN]);
    log(`  3c length < ${KW_MIN_LEN} chars: ${kw2.toLocaleString()} rows`);

    // 3d. frequency <= 1
    const { rowCount: kw3 } = await pool.query(`
      DELETE FROM article_keywords WHERE frequency <= $1
    `, [KW_MIN_FREQ]);
    log(`  3d frequency <= ${KW_MIN_FREQ}: ${kw3.toLocaleString()} rows`);

    // 3e. global rare (< MIN_GLOBAL occurrences) — batched to avoid long locks
    let kw4Total = 0;
    while (true) {
      const { rowCount } = await pool.query(`
        DELETE FROM article_keywords
         WHERE id IN (
           SELECT ak.id
             FROM article_keywords ak
             JOIN (
               SELECT keyword
                 FROM article_keywords
                GROUP BY keyword
               HAVING COUNT(*) < $1
                LIMIT $2
             ) low ON low.keyword = ak.keyword
         )
      `, [KW_MIN_GLOBAL, KW_BATCH]);
      if (rowCount === 0) break;
      kw4Total += rowCount;
    }
    log(`  3e global < ${KW_MIN_GLOBAL} occurrences: ${kw4Total.toLocaleString()} rows`);

    // 3f. trim per-article tail to top-N by frequency
    const { rowCount: kw5 } = await pool.query(`
      DELETE FROM article_keywords
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY frequency DESC) AS rn
             FROM article_keywords
         ) ranked
        WHERE rn > $1
       )
    `, [KW_MAX_PER_ARTICLE]);
    log(`  3f beyond top ${KW_MAX_PER_ARTICLE} per article: ${kw5.toLocaleString()} rows`);

    const totalKw = kw0 + kw1 + kw2 + kw3 + kw4Total + kw5;
    log(`  Total article_keywords purged: ${totalKw.toLocaleString()} rows`);
  } else {
    // Dry-run: just count what each rule would remove (additive, so an
    // upper bound — rules overlap, e.g. a numeric short keyword counts in
    // both 3b and 3c).
    const counts = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM article_keywords WHERE article_id NOT IN (SELECT id FROM news_articles)`),
      pool.query(`SELECT COUNT(*)::int AS c FROM article_keywords WHERE keyword ~ '^[0-9]+$'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM article_keywords WHERE LENGTH(keyword) < $1`, [KW_MIN_LEN]),
      pool.query(`SELECT COUNT(*)::int AS c FROM article_keywords WHERE frequency <= $1`, [KW_MIN_FREQ]),
    ]);
    log(`  3a orphans:              ~${counts[0].rows[0].c.toLocaleString()} rows`);
    log(`  3b pure numeric:         ~${counts[1].rows[0].c.toLocaleString()} rows`);
    log(`  3c length < ${KW_MIN_LEN} chars:     ~${counts[2].rows[0].c.toLocaleString()} rows`);
    log(`  3d frequency <= ${KW_MIN_FREQ}:        ~${counts[3].rows[0].c.toLocaleString()} rows`);
    log(`  (3e/3f counts skipped in dry-run — too expensive without temp tables)`);
  }

  // ─── 4. image_usage_log: prune old entries ──────────────────────────────
  log("Phase 4: image_usage_log cleanup...");
  if (!DRY_RUN) {
    const { rowCount } = await pool.query(`
      DELETE FROM image_usage_log WHERE used_at < NOW() - INTERVAL '14 days'
    `);
    log(`  Purged ${rowCount.toLocaleString()} image_usage_log rows`);
  } else {
    const { rows: [{ count }] } = await pool.query(`
      SELECT COUNT(*) AS count FROM image_usage_log WHERE used_at < NOW() - INTERVAL '14 days'
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} image_usage_log rows`);
  }

  // ─── 5. rss_error_logs: prune old errors ────────────────────────────────
  log("Phase 5: rss_error_logs cleanup...");
  if (!DRY_RUN) {
    const { rowCount } = await pool.query(`
      DELETE FROM rss_error_logs WHERE created_at < NOW() - INTERVAL '30 days'
    `);
    log(`  Purged ${rowCount.toLocaleString()} rss_error_logs rows`);
  } else {
    const { rows: [{ count }] } = await pool.query(`
      SELECT COUNT(*) AS count FROM rss_error_logs WHERE created_at < NOW() - INTERVAL '30 days'
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} rss_error_logs rows`);
  }

  // ─── 6. Dormant threads/timelines older than 6 months ───────────────────
  log("Phase 6: stale dormant threads/timelines...");
  if (!DRY_RUN) {
    const { rowCount: dormantThreads } = await pool.query(`
      DELETE FROM story_threads
      WHERE status = 'dormant'
        AND last_updated_at < NOW() - INTERVAL '180 days'
    `);
    const { rowCount: dormantTimelines } = await pool.query(`
      DELETE FROM story_timelines
      WHERE status = 'dormant'
        AND last_updated_at < NOW() - INTERVAL '180 days'
    `);
    log(`  Purged ${dormantThreads} dormant threads, ${dormantTimelines} dormant timelines`);
  }

  // ─── 7. VACUUM ANALYZE on affected tables ───────────────────────────────
  if (!DRY_RUN) {
    log("Phase 7: VACUUM ANALYZE on pruned tables...");
    const tables = [
      'keyword_daily_stats', 'news_articles', 'article_keywords',
      'article_locations', 'article_tags', 'image_usage_log',
      'rss_error_logs', 'briefing_episodes'
    ];
    for (const t of tables) {
      try {
        await pool.query(`VACUUM ANALYZE ${t}`);
        log(`  VACUUM ANALYZE ${t} ✓`);
      } catch (e) {
        log(`  VACUUM ANALYZE ${t} failed: ${e.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Done in ${elapsed}s`);
}

run()
  .catch(err => { console.error(`${TAG} FATAL:`, err); process.exit(1); })
  .finally(() => pool.end());
