#!/usr/bin/env node

// Cap DB pool before any module loads ./db. Cron does sequential VACUUM/
// DELETE work; 2 connections is plenty and keeps it from starving the API.
process.env.DB_POOL_MAX = "2";

/**
 * dbPruneCron.js — Weekly database pruning cron
 *
 * Deletes old, low-value data to keep Postgres lean:
 *
 * 1. keyword_daily_stats — purge rows with junk dates or older than 90 days
 * 2. news_articles — delete articles older than 90 days UNLESS they:
 *    a) belong to a story thread (story_thread_articles)
 *    b) belong to a story timeline (story_timeline_articles)
 *    c) are high-scoring (base_priority >= 5.0)
 *    d) are from tier 2/3/4 sources with decent priority (base_priority >= 3.0)
 *    e) are videos (media_type = 'video')
 *    Child rows (article_keywords, article_locations, article_tags,
 *    article_image_assignments, article_entities, article_entity_mentions,
 *    article_referenced_dates, article_entity_extraction_state, image_usage_log)
 *    cascade or are deleted explicitly.
 * 3. image_usage_log — prune entries older than 60 days
 * 4. rss_error_logs — prune entries older than 30 days
 * 5. briefing_episodes — REINDEX to fix bloated indexes
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
          WHERE date < CURRENT_DATE - INTERVAL '90 days'
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
      WHERE date < CURRENT_DATE - INTERVAL '90 days'
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
      WHERE a.published_at < NOW() - INTERVAL '90 days'
        AND a.base_priority < 5.0
        AND (a.media_type IS NULL OR a.media_type != 'video')
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
        )
        AND NOT (
          a.base_priority >= 3.0
          AND EXISTS (
            SELECT 1 FROM news_sources ns
            WHERE ns.id = a.source_id AND ns.fetch_tier >= 2
          )
        )
    `);
    log(`  Found ${Number(candidateCount).toLocaleString()} articles eligible for deletion`);

    if (Number(candidateCount) > 0) {
      // Create a temp table of article IDs to delete
      await pool.query(`
        CREATE TEMP TABLE _prune_article_ids AS
        SELECT a.id
        FROM news_articles a
        WHERE a.published_at < NOW() - INTERVAL '90 days'
          AND a.base_priority < 5.0
          AND (a.media_type IS NULL OR a.media_type != 'video')
          AND NOT EXISTS (
            SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
          )
          AND NOT (
            a.base_priority >= 3.0
            AND EXISTS (
              SELECT 1 FROM news_sources ns
              WHERE ns.id = a.source_id AND ns.fetch_tier >= 2
            )
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
      WHERE a.published_at < NOW() - INTERVAL '90 days'
        AND a.base_priority < 5.0
        AND (a.media_type IS NULL OR a.media_type != 'video')
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM story_timeline_articles stla WHERE stla.article_id = a.id
        )
        AND NOT (
          a.base_priority >= 3.0
          AND EXISTS (
            SELECT 1 FROM news_sources ns
            WHERE ns.id = a.source_id AND ns.fetch_tier >= 2
          )
        )
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} articles + child rows`);
  }

  // ─── 3. image_usage_log: prune old entries ──────────────────────────────
  log("Phase 3: image_usage_log cleanup...");
  if (!DRY_RUN) {
    const { rowCount } = await pool.query(`
      DELETE FROM image_usage_log WHERE used_at < NOW() - INTERVAL '60 days'
    `);
    log(`  Purged ${rowCount.toLocaleString()} image_usage_log rows`);
  } else {
    const { rows: [{ count }] } = await pool.query(`
      SELECT COUNT(*) AS count FROM image_usage_log WHERE used_at < NOW() - INTERVAL '60 days'
    `);
    log(`  Would delete ~${Number(count).toLocaleString()} image_usage_log rows`);
  }

  // ─── 4. rss_error_logs: prune old errors ────────────────────────────────
  log("Phase 4: rss_error_logs cleanup...");
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

  // ─── 5. Dormant threads/timelines older than 6 months ───────────────────
  log("Phase 5: stale dormant threads/timelines...");
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

  // ─── 6. VACUUM ANALYZE on affected tables ───────────────────────────────
  if (!DRY_RUN) {
    log("Phase 6: VACUUM ANALYZE on pruned tables...");
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
