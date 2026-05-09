/**
 * splitOversizedThreads.js
 *
 * Periodic split detection. Once a thread accumulates more than
 * SPLIT_THRESHOLD articles, send a cross-section of its members to
 * Claude Haiku and ask: "do these articles cover ONE story, or did
 * multiple distinct stories accidentally fuse into this thread?"
 *
 * If Claude returns 2+ clusters of size >= MIN_CLUSTER_SIZE, the script
 * keeps the largest cluster on the original thread (re-titling it to
 * match) and spins each other cluster off into a NEW thread.
 *
 * Companion to auditThreadArticles.js — the audit detaches outliers
 * from the dominant cluster and drops them; this script handles the
 * other failure mode: two equally-sized clusters that BOTH deserve to
 * be threads, but got merged.
 *
 * Usage:
 *   node splitOversizedThreads.js                       # dry-run, all eligible threads
 *   node splitOversizedThreads.js --apply               # apply: actually split
 *   node splitOversizedThreads.js --force               # ignore freshness gate — re-check every >=threshold thread
 *   node splitOversizedThreads.js --thread=8735         # specific thread (bypass gate)
 *   node splitOversizedThreads.js --threshold=200       # min article_count (default 200)
 *   node splitOversizedThreads.js --max-threads=20      # cap (default 20)
 *   node splitOversizedThreads.js --min-cluster=5       # min cluster size to spin off (default 5)
 *   node splitOversizedThreads.js --sample=150          # max articles sent to Claude (default 150)
 *   node splitOversizedThreads.js --model=claude-haiku-4-5
 */

require("dotenv").config({ override: true });
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { computeNationsForItem, enforceDisjointAndCapped } = require("./nationDesignations");

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY         = !!ARGV.get('apply');
const FORCE         = !!ARGV.get('force');
const MODEL         = ARGV.get('model') || 'claude-haiku-4-5';
const SPLIT_THRESHOLD = parseInt(ARGV.get('threshold') || '200', 10);
const MAX_THREADS   = parseInt(ARGV.get('max-threads') || '20', 10);
const MIN_CLUSTER_SIZE = parseInt(ARGV.get('min-cluster') || '5', 10);
const SAMPLE_LIMIT  = parseInt(ARGV.get('sample') || '150', 10);
const THREAD_FILTER = ARGV.get('thread')
  ? String(ARGV.get('thread')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
  : null;

async function main() {
  const t0 = Date.now();
  const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n✂️  Thread Split Detection — ${new Date().toISOString()}`);
  console.log(`   mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'}${FORCE ? ' | FORCE (gate bypassed)' : ''} | model: ${MODEL} | threshold=${SPLIT_THRESHOLD} | max=${MAX_THREADS} | min_cluster=${MIN_CLUSTER_SIZE}${THREAD_FILTER ? ` | ids=${THREAD_FILTER.join(',')}` : ''}\n`);

  const threads = await loadThreads();
  console.log(`   [${el()}] Loaded ${threads.length} candidate thread(s)`);

  let evaluated = 0;
  let splitCount = 0;
  let newThreadsCreated = 0;
  let articlesMoved = 0;

  for (const t of threads) {
    if (evaluated >= MAX_THREADS) break;

    // Live-count gate uses story_thread_articles JOIN news_articles —
    // matches what loadArticleSample sees, but BEFORE the sampling cap
    // is applied. Previously we called loadArticleSample first and
    // checked its return length against SPLIT_THRESHOLD, but
    // loadArticleSample stratifies down to SAMPLE_LIMIT (~150) so the
    // post-sample count was always ~150-152 and the check
    // "152 < 200, skipping" fired for EVERY oversized thread. Hence
    // the user-reported bug: court-blocks-tariffs (1898 articles),
    // mali-junta (340), trump-iran-deal (290), hantavirus (253) all
    // got skipped with the same misleading "live count 151" message.
    const liveCount = await getLiveArticleCount(t.id);
    if (liveCount < SPLIT_THRESHOLD) {
      console.log(`   [${el()}] thread ${t.id} live count ${liveCount} < ${SPLIT_THRESHOLD}, skipping`);
      await stampChecked(t.id);
      // Drift repair: cached column is wrong if we're here.
      await pool.query(
        `UPDATE story_threads SET article_count = $2 WHERE id = $1`,
        [t.id, liveCount]
      );
      continue;
    }

    const articles = await loadArticleSample(t.id);
    evaluated++;
    process.stdout.write(`   [${el()}] Thread ${t.id} (live=${liveCount}, sampled=${articles.length}) "${(t.title || '').slice(0, 60)}" → Claude... `);

    let result;
    try {
      result = await askClaude(t, articles);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      continue; // do not stamp — retry next run
    }

    const validClusters = (result.clusters || []).filter(c => Array.isArray(c.article_ids) && c.article_ids.length >= MIN_CLUSTER_SIZE);
    if (validClusters.length <= 1) {
      console.log(`✓ single story${validClusters[0]?.title ? ` ("${validClusters[0].title.slice(0, 60)}")` : ''}`);
      await stampChecked(t.id);
      continue;
    }

    // Sort clusters largest-first. Largest cluster stays on the original thread.
    validClusters.sort((a, b) => b.article_ids.length - a.article_ids.length);
    const [primary, ...secondary] = validClusters;
    splitCount++;

    console.log(`🔱 ${validClusters.length} clusters — primary=${primary.article_ids.length} | secondary=[${secondary.map(s => s.article_ids.length).join(',')}]`);
    for (const c of validClusters) {
      console.log(`       • ${c.article_ids.length} arts — "${(c.title || '').slice(0, 70)}"`);
    }

    if (!APPLY) {
      // Dry-run: don't stamp last_split_check_at so an --apply run will pick it up.
      continue;
    }

    try {
      const { newIds, moved } = await applySplit(t, primary, secondary, articles);
      newThreadsCreated += newIds.length;
      articlesMoved += moved;
      console.log(`     ✓ split applied — new thread IDs=[${newIds.join(',')}] moved=${moved}`);
      await stampChecked(t.id);
    } catch (err) {
      console.warn(`     ✗ split failed for thread ${t.id}: ${err.message}`);
    }
  }

  console.log(`\n${APPLY ? '✅ Split pass complete' : '✅ Dry run complete'} in ${el()}.`);
  console.log(`   evaluated=${evaluated} split=${splitCount} new_threads=${newThreadsCreated} articles_moved=${articlesMoved}`);
  await pool.end();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────
async function loadThreads() {
  if (THREAD_FILTER?.length) {
    const { rows } = await pool.query(
      `SELECT id, title, description, keywords, primary_category,
              article_count, primary_nations, secondary_nations
         FROM story_threads
        WHERE id = ANY($1::int[])`,
      [THREAD_FILTER]
    );
    return rows;
  }
  // Gate: thread has crossed the size threshold AND either (a) has never
  // been split-checked, (b) has accumulated new articles since the last
  // check, or (c) the last check is older than the periodic re-check
  // window. Active + cooling only — dormant threads are frozen and not
  // worth a Claude call.
  //
  // The periodic re-check (clause c, RECHECK_INTERVAL) is the catch-all:
  // a thread can grow from 200 → 800 articles without a single split
  // ever firing because the FIRST check (at 200) returned "single story"
  // and clause (b) only re-triggers on individual article adds bumping
  // last_updated_at. Subtle subject drift across hundreds of new articles
  // can flip a former single-story into a splittable one — but only the
  // periodic sweep will surface it.
  //
  // CRITICAL: filter on the LIVE count from story_thread_articles, not
  // the cached `story_threads.article_count` column. The cached column
  // drifts in both directions:
  //   - over-counts: storyThreadBuilder.js increments via `+=
  //     def.article_ids.length` while INSERTs use ON CONFLICT DO NOTHING,
  //     so duplicates inflate the counter without adding rows.
  //   - under-counts: audit/repair passes detach articles but their
  //     decrement paths can race with attaches.
  // An earlier run loaded 4 threads where stored count >= 200 but live
  // count was 151–152 (over-count case). The under-count case silently
  // excluded real >200-article threads from candidacy — the live JOIN
  // fixes both.
  const RECHECK_INTERVAL = '3 days';
  // --force drops the freshness clause entirely: every active/cooling
  // thread at >= threshold becomes a candidate this run, including ones
  // checked an hour ago. Use for one-off audits / catching up after a
  // prompt change. Still honors MAX_THREADS so you don't accidentally
  // burn 500 Claude calls in a single shot.
  const freshnessClause = FORCE
    ? ''
    : `AND (
         t.last_split_check_at IS NULL
         OR t.last_updated_at > t.last_split_check_at
         OR t.last_split_check_at < NOW() - INTERVAL '${RECHECK_INTERVAL}'
       )`;
  const { rows } = await pool.query(`
    SELECT t.id, t.title, t.description, t.keywords, t.primary_category,
           cnt.live_count AS article_count,
           t.primary_nations, t.secondary_nations
      FROM story_threads t
      JOIN (
        SELECT thread_id, COUNT(*)::int AS live_count
          FROM story_thread_articles
         GROUP BY thread_id
      ) cnt ON cnt.thread_id = t.id
     WHERE t.status IN ('active','cooling')
       AND cnt.live_count >= $1
       ${freshnessClause}
     ORDER BY cnt.live_count DESC
     LIMIT $2
  `, [SPLIT_THRESHOLD, MAX_THREADS]);
  return rows;
}

// Live count of attached articles WITH a matching news_articles row —
// the JOIN matches what loadArticleSample sees so the gate stays in
// agreement with what we'll actually feed Claude. Counting against
// story_thread_articles alone would let orphan attachments inflate the
// number; counting against the cached story_threads.article_count
// drifts (it can over- or under-count).
async function getLiveArticleCount(threadId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM story_thread_articles sta
       JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.thread_id = $1`,
    [threadId]
  );
  return rows[0]?.c || 0;
}

// Stratified sample so Claude sees the thread's full arc, not just
// recent drift. Mirrors fetchThreadMembers's percentile slot logic but
// returns up to SAMPLE_LIMIT articles instead of just 5.
async function loadArticleSample(threadId) {
  // Pull every attached article's id+published_at so we can do
  // percentile slicing in JS. For threads at our threshold (200–2000
  // articles) this is a few hundred rows — cheap.
  const { rows: all } = await pool.query(`
    SELECT a.id,
           COALESCE(a.translated_title, a.title)     AS title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           COALESCE(ns.name, ys.name)                AS source_name,
           co.iso_code                               AS country_iso,
           co.name                                   AS country_name,
           a.published_at,
           sta.is_anchor, sta.relevance_score
      FROM story_thread_articles sta
      JOIN news_articles a        ON a.id = sta.article_id
      LEFT JOIN news_sources ns   ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co      ON co.id = a.country_id
     WHERE sta.thread_id = $1
     ORDER BY a.published_at ASC
  `, [threadId]);
  if (all.length <= SAMPLE_LIMIT) return all;
  // Even-stride sample across the arc + always include anchor + most-recent.
  const sample = new Map();
  const stride = all.length / SAMPLE_LIMIT;
  for (let i = 0; i < SAMPLE_LIMIT; i++) {
    const idx = Math.min(all.length - 1, Math.floor(i * stride));
    const a = all[idx];
    sample.set(a.id, a);
  }
  // Force-include anchor (if any) and most-recent.
  const anchor = all.find(a => a.is_anchor);
  if (anchor) sample.set(anchor.id, anchor);
  const newest = all[all.length - 1];
  sample.set(newest.id, newest);
  return [...sample.values()];
}

async function stampChecked(threadId) {
  await pool.query(
    `UPDATE story_threads SET last_split_check_at = NOW() WHERE id = $1`,
    [threadId]
  );
}

// ─── Claude prompt ───────────────────────────────────────────────────────────
async function askClaude(thread, articles) {
  const threadBlock = `THREAD (stored metadata — these may be stale; trust the articles, not the title):
- id: ${thread.id}
- stored title: "${thread.title || ''}"
- category: ${thread.primary_category || 'unknown'}
- article_count: ${thread.article_count}
- keywords: ${(thread.keywords || []).slice(0, 20).join(', ')}`;

  const articleBlock = articles.map(a =>
    `#${a.id} [${a.country_iso || '??'} ${a.published_at?.toISOString?.()?.slice(0,10) || '????-??-??'}] "${(a.title || '').slice(0, 140)}"`
  ).join('\n');

  const prompt = `You are auditing a news-thread for accidental fusion. A thread should cover ONE ongoing story (one event, one decision, one actor's narrative arc). Threads sometimes accidentally fuse two distinct stories that share a generic keyword like "ceasefire" or "election".

Read every article below. Decide whether they form ONE story or split cleanly into MULTIPLE distinct stories.

Return ONLY valid JSON in this exact shape:
{
  "clusters": [
    {
      "title": "concise specific title (under 80 chars) — name the actors/event, no generic words",
      "description": "one-sentence story summary",
      "primary_category": "politics | military | diplomacy | economy | culture | environment | health | technology | sports | other",
      "keywords": ["6-12 specific keywords, no generic ones like 'crisis' or 'war'"],
      "primary_nations": ["ISO codes, 1-3 of them, the countries this cluster is actually about"],
      "article_ids": [list of article IDs in this cluster]
    }
  ]
}

Rules:
- If all articles cover the SAME story, return exactly 1 cluster (with all article IDs).
- A cluster needs at least ${MIN_CLUSTER_SIZE} articles to be reported. Stragglers from a different topic with <${MIN_CLUSTER_SIZE} articles should be ASSIGNED to the closest cluster, not a separate cluster.
- Articles in the same cluster MUST share specific actors/events — not just a common topic word. "Israel-Lebanon ceasefire" and "Russia-Ukraine ceasefire" are DIFFERENT clusters even though both involve a ceasefire.
- An article id appears in EXACTLY one cluster. The union of all article_ids must equal every article ID I gave you.
- Title each cluster from the articles, NOT from the thread's stored title.

${threadBlock}

ARTICLES (id, [country date], title):
${articleBlock}`;

  const resp = await claude.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content?.[0]?.text || '';
  const json = parseJson(text);
  if (!json || !Array.isArray(json.clusters)) {
    throw new Error('Claude returned invalid JSON shape');
  }
  // Coerce article_ids to numbers + drop unknown ids.
  const validIds = new Set(articles.map(a => Number(a.id)));
  for (const c of json.clusters) {
    c.article_ids = (c.article_ids || []).map(Number).filter(id => validIds.has(id));
  }
  return json;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

// ─── Apply ───────────────────────────────────────────────────────────────────
async function applySplit(thread, primary, secondary, sampledArticles) {
  // We only got Claude's verdict on the SAMPLED articles. Articles
  // that weren't in the sample stay on the original thread by default
  // — they'll be re-evaluated next time the gate fires. This is the
  // safe choice: never orphan an article based on a partial-sample
  // verdict.
  //
  // For each secondary cluster:
  //   1. Create a new story_threads row using the cluster's metadata.
  //   2. INSERT story_thread_articles rows for that cluster's article_ids
  //      (carrying over relevance_score; is_anchor=false on the new
  //      thread since the founding anchor stays with the primary).
  //   3. DELETE those article_ids from the original thread.
  //   4. Recompute article_count + nations + breaking_signal on both
  //      old and new thread.
  // Re-title the original thread from primary cluster's metadata.

  const newIds = [];
  let moved = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const cluster of secondary) {
      const ids = cluster.article_ids;
      if (!ids.length) continue;

      // Create new thread.
      const { primary: pNations, secondary: sNations } =
        enforceDisjointAndCapped(cluster.primary_nations || [], []);
      const { rows: ins } = await client.query(`
        INSERT INTO story_threads
          (title, description, primary_category, geographic_scope,
           importance, keywords, article_count,
           primary_nations, secondary_nations,
           first_seen_at, last_updated_at)
        VALUES ($1, $2, $3, 'global', $4, $5, 0, $6, $7, NOW(), NOW())
        RETURNING id
      `, [
        cluster.title || `Split from ${thread.id}`,
        cluster.description || null,
        cluster.primary_category || thread.primary_category || 'other',
        thread.importance || 5,
        cluster.keywords || [],
        pNations,
        sNations,
      ]);
      const newId = ins[0].id;
      newIds.push(newId);

      // Move article rows. We re-INSERT with is_anchor=false because
      // the source thread's anchor stays with the primary cluster by
      // construction (anchor is in primary). carry over relevance_score
      // from the source row.
      await client.query(`
        INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor, added_at)
        SELECT $2, sta.article_id, sta.relevance_score, false, sta.added_at
          FROM story_thread_articles sta
         WHERE sta.thread_id = $1
           AND sta.article_id = ANY($3::int[])
        ON CONFLICT DO NOTHING
      `, [thread.id, newId, ids]);

      const { rowCount: del } = await client.query(`
        DELETE FROM story_thread_articles
         WHERE thread_id = $1 AND article_id = ANY($2::int[])
      `, [thread.id, ids]);
      moved += del;

      // Recount on both threads.
      await client.query(`
        UPDATE story_threads
           SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = id)
         WHERE id = ANY($1::int[])
      `, [[thread.id, newId]]);
    }

    // Re-title original thread from primary cluster's metadata, in case
    // the stored title was a forced merger of multiple stories.
    if (primary && primary.title) {
      const { primary: pNations, secondary: sNations } =
        enforceDisjointAndCapped(primary.primary_nations || thread.primary_nations || [], []);
      await client.query(`
        UPDATE story_threads
           SET title             = $2,
               description       = COALESCE($3, description),
               primary_category  = COALESCE($4, primary_category),
               keywords          = $5,
               primary_nations   = $6,
               secondary_nations = $7,
               last_updated_at   = NOW()
         WHERE id = $1
      `, [
        thread.id,
        primary.title,
        primary.description || null,
        primary.primary_category || null,
        primary.keywords || thread.keywords || [],
        pNations,
        sNations,
      ]);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Post-commit recomputes (use pool, not the dedicated client which
  // may have been released). Nation recompute reads article_entity_mentions
  // and is independent per thread.
  for (const id of [thread.id, ...newIds]) {
    try {
      const { primary: p, secondary: s } = await computeNationsForItem(pool, 'thread', id);
      await pool.query(
        `UPDATE story_threads
            SET primary_nations = $2::text[], secondary_nations = $3::text[]
          WHERE id = $1`,
        [id, p, s]
      );
    } catch (_) { /* nation recompute is best-effort */ }
  }

  return { newIds, moved };
}

main().catch(e => { console.error(e); process.exit(1); });
