/**
 * relinkExistingTimelines.js — ONE-SHOT BACK-LINKER
 *
 * Migrates the ~400 timelines that exist PRE-v3 (created by the old
 * raw-article clustering Phases 1–3) into the new threads→timelines
 * graph by populating story_threads.timeline_id for every thread that
 * overlaps meaningfully with a timeline.
 *
 * After the v3 rewrite, storyTimelineBuilder.js only *creates* new
 * links via thread graduation. Historical timelines have zero threads
 * attached because the column didn't exist when they were built. This
 * script fills the gap in one pass.
 *
 * Algorithm — per thread:
 *   1. Find every timeline whose article set shares articles with this
 *      thread's article set.
 *   2. Score overlap = |shared| / |thread articles|. If ≥ OVERLAP_MIN
 *      we're confident it's the same story.
 *   3. Among qualifying timelines, pick the one with the most shared
 *      articles (break ties by timeline importance DESC, then timeline
 *      age DESC so older / more established timelines win).
 *   4. Set thread.timeline_id = winner.
 *
 * Leaves threads that don't meaningfully overlap any timeline with
 * NULL timeline_id — storyTimelineBuilder will re-evaluate them on its
 * next promotion pass using the same entity/nation/keyword matching it
 * uses for everything else. No dedicated "orphan" column.
 *
 * Usage:
 *   node relinkExistingTimelines.js             — dry run, report only
 *   node relinkExistingTimelines.js --apply     — commit changes
 *   node relinkExistingTimelines.js --apply --overlap=0.5  — stricter
 *
 * Idempotent — safe to re-run. Only touches threads whose timeline_id
 * is currently NULL (re-runs won't disturb already-linked threads).
 */

'use strict';

// One-shot back-linker. Cap concurrent DB connections; sequential.
process.env.DB_POOL_MAX = "2";

require('dotenv').config();
const pool = require('./db');

const APPLY        = process.argv.includes('--apply');
const OVERLAP_MIN  = parseFloat(
  process.argv.find(a => a.startsWith('--overlap='))?.split('=')[1] || '0.40'
);
const MAX_THREADS  = parseInt(
  process.argv.find(a => a.startsWith('--max='))?.split('=')[1] || '5000',
  10
);

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🔗 Relink Existing Timelines — ${new Date().toISOString()}`);
  console.log(`   mode=${APPLY ? 'APPLY' : 'dry-run'}  overlap_min=${OVERLAP_MIN}  max_threads=${MAX_THREADS}`);

  // Dedicated client — the per-thread loop below can be thousands of
  // queries, well past the default pool-checkout timeout if we round-
  // tripped through the pool for each one. One connection held for the
  // full run, 10-min statement_timeout on the heavier initial SELECT.
  const db = await pool.connect();
  try {
    await db.query('SET statement_timeout = 600000');

    // ── Fetch unlinked threads ──────────────────────────────────────────
    const { rows: threadRows } = await db.query(`
      SELECT t.id, t.title, t.article_count, t.timeline_id
      FROM story_threads t
      WHERE t.timeline_id IS NULL
        AND t.article_count > 0
      ORDER BY t.importance DESC NULLS LAST, t.article_count DESC, t.last_updated_at DESC
      LIMIT $1
    `, [MAX_THREADS]);
    console.log(`   [${elapsed()}] ${threadRows.length} unlinked thread(s) to evaluate`);

    if (!threadRows.length) { console.log('   Nothing to link. Done.'); return; }

    // Per-thread scan. One overlap-pick query each; the same connection
    // reused across the loop so we don't thrash the pool.
    let linked = 0;
    let skipped = 0;
    const tally = new Map();  // timelineId → count of threads linked

    for (let i = 0; i < threadRows.length; i++) {
      const thread = threadRows[i];

      const { rows: matches } = await db.query(`
        SELECT
          sta_tl.timeline_id,
          t.title          AS tl_title,
          t.importance     AS tl_importance,
          t.first_seen_at  AS tl_age,
          COUNT(*)::int    AS shared_articles
        FROM story_thread_articles sta_th
        JOIN story_timeline_articles sta_tl ON sta_tl.article_id = sta_th.article_id
        JOIN story_timelines t              ON t.id = sta_tl.timeline_id
        WHERE sta_th.thread_id = $1
          AND t.status IN ('active','cooling','dormant')
        GROUP BY sta_tl.timeline_id, t.title, t.importance, t.first_seen_at
        ORDER BY shared_articles DESC, t.importance DESC NULLS LAST, t.first_seen_at ASC
        LIMIT 1
      `, [thread.id]);

      if (!matches.length) { skipped++; continue; }
      const m = matches[0];
      const overlap = Number(m.shared_articles) / Math.max(thread.article_count, 1);

      if (overlap < OVERLAP_MIN) { skipped++; continue; }

      tally.set(m.timeline_id, (tally.get(m.timeline_id) || 0) + 1);
      linked++;

      if (APPLY) {
        await db.query(
          `UPDATE story_threads SET timeline_id = $1 WHERE id = $2 AND timeline_id IS NULL`,
          [m.timeline_id, thread.id]
        );
      }

      // Progress: first 20 always, then every 250
      if (i < 20 || i % 250 === 0) {
        console.log(`   [${elapsed()}] thread ${thread.id} "${(thread.title || '').slice(0,50)}" ↪ tl ${m.timeline_id} "${(m.tl_title || '').slice(0,50)}" (${m.shared_articles}/${thread.article_count} = ${(overlap*100).toFixed(0)}%)`);
      }
    }

    console.log(`\n═══ RELINK SUMMARY (${elapsed()}) ═══`);
    console.log(`  mode             : ${APPLY ? 'APPLIED' : 'DRY RUN (pass --apply to commit)'}`);
    console.log(`  threads scanned  : ${threadRows.length}`);
    console.log(`  threads linked   : ${linked}`);
    console.log(`  threads skipped  : ${skipped}  (< ${(OVERLAP_MIN*100).toFixed(0)}% overlap or no shared articles)`);
    console.log(`  unique timelines receiving threads: ${tally.size}`);

    // Show top timelines by thread count for a sanity check
    const topTimelines = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topTimelines.length) {
      console.log(`\n  top 10 timelines by linked-thread count:`);
      for (const [tlid, n] of topTimelines) {
        const { rows: tlRow } = await db.query(
          `SELECT title FROM story_timelines WHERE id = $1`, [tlid]
        );
        console.log(`    ${String(n).padStart(4)}  [${tlid}]  ${(tlRow[0]?.title || '').slice(0,70)}`);
      }
    }

    if (APPLY) {
      console.log(`\n✅ Linked. Run storyTimelineBuilder next to refresh primary_nations + extract events.`);
    } else {
      console.log(`\nDry run complete. Re-run with --apply to commit.`);
    }
  } finally {
    db.release();
  }
  await pool.end();
}

run().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
