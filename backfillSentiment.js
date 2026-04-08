/**
 * backfillSentiment.js
 *
 * Populates news_articles.sentiment_score for every article where it's
 * currently NULL, using the zero-cost lexicon scorer in sentimentLexicon.js.
 *
 * Safety:
 *   - NEVER overwrites existing scores (deepAnalyzer.js / Claude Haiku writes
 *     take precedence).
 *   - Batched updates, resumable (re-running picks up where it left off
 *     because it always targets sentiment_score IS NULL).
 *   - Dry-run mode with --dry for sanity checks.
 *   - --limit N to process a small sample first.
 *   - Idempotent: running it twice on the same data yields the same result.
 *
 * Usage:
 *   node backfillSentiment.js --dry --limit 200
 *   node backfillSentiment.js --limit 5000
 *   node backfillSentiment.js               # full backfill
 *   node backfillSentiment.js --since 2026-01-01
 *
 * Flags:
 *   --dry           Read-only: score + print distribution, no writes
 *   --limit N       Only process the first N null rows
 *   --since DATE    Only process articles with published_at >= DATE
 *   --batch N       Update batch size (default 500)
 *   --verbose       Print per-batch logs
 */

'use strict';

const pool = require('./db');
const { scoreArticle } = require('./sentimentLexicon');

// ─── Args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name)      { return argv.includes(`--${name}`); }
function optVal(name)    {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const DRY       = flag('dry');
const VERBOSE   = flag('verbose');
const LIMIT     = parseInt(optVal('limit'), 10) || null;
const SINCE     = optVal('since');
const BATCH     = parseInt(optVal('batch'), 10) || 500;

// ─── Stats ──────────────────────────────────────────────────────────────────
const stats = {
  scanned: 0,
  matched: 0,
  null_after: 0,
  written: 0,
  batches: 0,
  bucketHist: { vneg: 0, neg: 0, neu: 0, pos: 0, vpos: 0 },
  startedAt: Date.now()
};

function classify(s) {
  if (s == null) return null;
  if (s <= -0.6) return 'vneg';
  if (s <= -0.2) return 'neg';
  if (s <   0.2) return 'neu';
  if (s <   0.6) return 'pos';
  return 'vpos';
}

function humanDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎯 backfillSentiment starting');
  console.log(`   mode      : ${DRY ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`   batch     : ${BATCH}`);
  if (LIMIT) console.log(`   limit     : ${LIMIT}`);
  if (SINCE) console.log(`   since     : ${SINCE}`);
  console.log('');

  // Pre-count (scope only; we'll advance via id cursor inside the loop)
  const preCountParams = [];
  const preCountWhere = ['a.sentiment_score IS NULL'];
  if (SINCE) {
    preCountParams.push(SINCE);
    preCountWhere.push(`a.published_at >= $${preCountParams.length}::date`);
  }
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::bigint AS n FROM news_articles a WHERE ${preCountWhere.join(' AND ')}`,
    preCountParams
  );
  const totalNull = parseInt(countRows[0].n, 10);
  console.log(`   null rows to process: ${totalNull.toLocaleString()}${LIMIT ? ` (limited to ${LIMIT.toLocaleString()})` : ''}`);
  console.log('');

  if (totalNull === 0) {
    console.log('Nothing to do — every article already has a sentiment_score.');
    await pool.end();
    return;
  }

  // Pagination strategy: always-advancing id cursor.
  //   - Every batch selects `a.id > lastId AND sentiment_score IS NULL`
  //     ordered by id.
  //   - After scoring, bump lastId to the max id seen in this batch. This
  //     naturally skips both "just-updated" rows (now non-null) and
  //     "unmatched" rows (no signal words; left NULL but > lastId next pass).
  //   - Works identically in DRY mode because we still advance the cursor.
  let lastId = 0;
  let keepGoing = true;

  while (keepGoing) {
    if (LIMIT && stats.scanned >= LIMIT) break;

    const fetchLimit = LIMIT
      ? Math.min(BATCH, LIMIT - stats.scanned)
      : BATCH;

    const params = [lastId];
    const whereBits = ['a.sentiment_score IS NULL', `a.id > $${params.length}`];
    if (SINCE) {
      params.push(SINCE);
      whereBits.push(`a.published_at >= $${params.length}::date`);
    }

    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.summary, a.translated_title, a.translated_summary
         FROM news_articles a
        WHERE ${whereBits.join(' AND ')}
        ORDER BY a.id ASC
        LIMIT ${fetchLimit}`,
      params
    );

    if (!rows.length) { keepGoing = false; break; }

    // Advance cursor to the max id in this batch (even unmatched rows)
    lastId = rows[rows.length - 1].id;

    // Score in-memory
    const updates = [];
    for (const r of rows) {
      stats.scanned++;
      const { score, matched } = scoreArticle(r);
      if (matched) {
        stats.matched++;
        const bucket = classify(score);
        if (bucket) stats.bucketHist[bucket]++;
        updates.push([r.id, score]);
      } else {
        stats.null_after++;
      }
    }

    if (!DRY && updates.length) {
      const ids    = updates.map(u => u[0]);
      const scores = updates.map(u => u[1]);
      const result = await pool.query(
        `UPDATE news_articles a
            SET sentiment_score = v.score
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::float8[]) AS score) v
          WHERE a.id = v.id
            AND a.sentiment_score IS NULL`,
        [ids, scores]
      );
      stats.written += result.rowCount || 0;
    }

    stats.batches++;
    if (VERBOSE || stats.batches % 10 === 0) {
      const pct = LIMIT ? ((stats.scanned / LIMIT) * 100).toFixed(1)
                        : ((stats.scanned / totalNull) * 100).toFixed(1);
      const rate = stats.scanned / Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
      console.log(
        `  batch ${stats.batches.toString().padStart(4)}  ` +
        `scanned=${stats.scanned.toLocaleString().padStart(10)}  ` +
        `matched=${stats.matched.toLocaleString().padStart(10)}  ` +
        `written=${stats.written.toLocaleString().padStart(10)}  ` +
        `${pct}%  ${rate.toFixed(0)}/s`
      );
    }
  }

  const elapsed = Date.now() - stats.startedAt;
  console.log('');
  console.log('───────────────────────────────────────');
  console.log('✅ backfillSentiment complete');
  console.log(`   scanned     : ${stats.scanned.toLocaleString()}`);
  console.log(`   matched     : ${stats.matched.toLocaleString()} (${((stats.matched / Math.max(1, stats.scanned)) * 100).toFixed(1)}%)`);
  console.log(`   unmatched   : ${stats.null_after.toLocaleString()} (no signal words — left NULL)`);
  console.log(`   written     : ${stats.written.toLocaleString()}${DRY ? ' (dry run — nothing actually written)' : ''}`);
  console.log(`   elapsed     : ${humanDuration(elapsed)}`);
  console.log('');
  console.log('   sentiment distribution (of matched):');
  const h = stats.bucketHist;
  const total = h.vneg + h.neg + h.neu + h.pos + h.vpos;
  const bar = (n) => {
    if (!total) return '';
    const pct = (n / total) * 100;
    return `${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(pct / 2))}`;
  };
  console.log(`     very-negative [-1 .. -0.6]  ${bar(h.vneg)}`);
  console.log(`     negative      [-0.6 .. -0.2] ${bar(h.neg)}`);
  console.log(`     neutral       [-0.2 .. 0.2]  ${bar(h.neu)}`);
  console.log(`     positive      [0.2 .. 0.6]   ${bar(h.pos)}`);
  console.log(`     very-positive [0.6 .. 1]     ${bar(h.vpos)}`);
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('❌ backfill failed:', err);
  pool.end().finally(() => process.exit(1));
});
