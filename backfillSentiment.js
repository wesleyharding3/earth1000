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
const fs   = require('fs');
const path = require('path');
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
const STATUS    = flag('status');   // print current DB coverage + exit
const NO_RESUME = flag('no-resume'); // ignore checkpoint and start from id=0
const RESET     = flag('reset');     // delete checkpoint before starting
const LIMIT     = parseInt(optVal('limit'), 10) || null;
const SINCE     = optVal('since');
const BATCH     = parseInt(optVal('batch'), 10) || 500;
const CHECKPOINT_PATH = path.join(__dirname, '.backfillSentiment.progress.json');

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
  if (ms < 3600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

// ─── Checkpoint file (live progress you can `cat` from another terminal) ───
function writeCheckpoint(extra) {
  const elapsed = Date.now() - stats.startedAt;
  const rate    = stats.scanned / Math.max(0.001, elapsed / 1000);
  const payload = {
    pid: process.pid,
    started_at: new Date(stats.startedAt).toISOString(),
    updated_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    elapsed: humanDuration(elapsed),
    rows_per_sec: Math.round(rate),
    scanned: stats.scanned,
    matched: stats.matched,
    unmatched: stats.null_after,
    written: stats.written,
    batches: stats.batches,
    last_id: extra?.lastId ?? null,
    total_null: extra?.totalNull ?? null,
    percent_complete: extra?.totalNull
      ? +(((stats.scanned) / (LIMIT || extra.totalNull)) * 100).toFixed(2)
      : null,
    eta: extra?.eta ?? null,
    distribution: { ...stats.bucketHist },
    mode: DRY ? 'dry' : 'live',
    limit: LIMIT,
    since: SINCE || null
  };
  try {
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(payload, null, 2));
  } catch (e) { /* checkpoint is best-effort */ }
}

function clearCheckpoint() {
  try { fs.unlinkSync(CHECKPOINT_PATH); } catch (e) { /* ignore */ }
}

function loadCheckpoint() {
  try {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    // Guard against cross-run mode mismatch (don't resume live from a dry run)
    if (cp.mode && cp.mode !== (DRY ? 'dry' : 'live')) return null;
    return cp;
  } catch (e) { return null; }
}

// ── Retry wrapper: survives connection drops / statement timeouts ───────────
// The pool will transparently reconnect on the next query, but we need to
// catch the error and retry with exponential backoff so a network blip or
// transient Render Postgres hiccup doesn't kill a multi-hour backfill.
async function withRetry(label, fn, { tries = 6, baseMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (_shuttingDown) throw new Error('shutdown in progress');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Pool-closed errors mean we're shutting down — stop immediately.
      if (/Cannot use a pool after calling end/i.test(err.message || '')) throw err;
      const transient =
        err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === '57014' ||        // query_canceled (statement_timeout)
        err.code === '08006' ||        // connection_failure
        err.code === '08003' ||        // connection_does_not_exist
        err.code === '08001' ||        // sqlclient_unable_to_establish_sqlconnection
        /terminat|reset|timeout|ECONN|Connection/i.test(err.message || '');
      if (!transient) throw err;
      const wait = baseMs * Math.pow(2, i);
      console.warn(`\n⚠️  ${label} failed (${err.code || err.message}) — retry ${i + 1}/${tries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ─── `--status` short-circuit: print current DB coverage and exit ──────────
async function printStatus() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::bigint                                  AS total,
      COUNT(sentiment_score)::bigint                    AS scored,
      COUNT(*) FILTER (WHERE sentiment_score IS NULL)::bigint AS null_rows,
      ROUND(AVG(sentiment_score)::numeric, 4)           AS avg_sent,
      MIN(published_at)                                 AS earliest,
      MAX(published_at)                                 AS latest
    FROM news_articles
  `);
  const r = rows[0];
  const total  = Number(r.total);
  const scored = Number(r.scored);
  const nulls  = Number(r.null_rows);
  const pct    = total ? ((scored / total) * 100).toFixed(2) : '0.00';

  console.log('📊 sentiment_score coverage');
  console.log(`   total articles : ${total.toLocaleString()}`);
  console.log(`   scored         : ${scored.toLocaleString()} (${pct}%)`);
  console.log(`   null           : ${nulls.toLocaleString()}`);
  console.log(`   avg score      : ${r.avg_sent ?? '—'}`);
  console.log(`   range          : ${r.earliest?.toISOString?.() || '—'}  →  ${r.latest?.toISOString?.() || '—'}`);

  // If a backfill is currently running, show its checkpoint
  if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
      const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      console.log('');
      console.log('🏃 active backfill checkpoint:');
      console.log(`   pid            : ${cp.pid}`);
      console.log(`   started        : ${cp.started_at}`);
      console.log(`   updated        : ${cp.updated_at}`);
      console.log(`   elapsed        : ${cp.elapsed}`);
      console.log(`   scanned        : ${cp.scanned.toLocaleString()}${cp.total_null ? ` / ${cp.total_null.toLocaleString()}` : ''}`);
      console.log(`   written        : ${cp.written.toLocaleString()}`);
      console.log(`   rate           : ${cp.rows_per_sec} rows/s`);
      if (cp.percent_complete != null) console.log(`   progress       : ${cp.percent_complete}%`);
      if (cp.eta) console.log(`   eta            : ${cp.eta}`);
    } catch (e) {
      console.log(`(couldn't read checkpoint file: ${e.message})`);
    }
  }
  await pool.end();
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (STATUS) { await printStatus(); return; }
  if (RESET) { clearCheckpoint(); console.log('🗑  checkpoint cleared'); }

  // Try to resume from an existing checkpoint
  const resumeCp = NO_RESUME ? null : loadCheckpoint();
  let resumeLastId = 0;
  if (resumeCp) {
    resumeLastId = resumeCp.last_id || 0;
    // Carry forward counters so stats + ETA stay coherent across resumes
    stats.scanned    = resumeCp.scanned || 0;
    stats.matched    = resumeCp.matched || 0;
    stats.null_after = resumeCp.unmatched || 0;
    stats.written    = resumeCp.written || 0;
    stats.batches    = resumeCp.batches || 0;
    if (resumeCp.distribution) {
      for (const k of Object.keys(stats.bucketHist)) {
        if (typeof resumeCp.distribution[k] === 'number') {
          stats.bucketHist[k] = resumeCp.distribution[k];
        }
      }
    }
  }

  console.log('🎯 backfillSentiment starting');
  console.log(`   mode      : ${DRY ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`   batch     : ${BATCH}`);
  if (LIMIT) console.log(`   limit     : ${LIMIT}`);
  if (SINCE) console.log(`   since     : ${SINCE}`);
  if (resumeCp) {
    console.log(`   resuming  : last_id=${resumeLastId}  prev_scanned=${stats.scanned.toLocaleString()}  prev_written=${stats.written.toLocaleString()}`);
  } else {
    console.log(`   resume    : (no checkpoint — starting from id=0)`);
  }
  console.log('');

  // Pre-count (scope only; we'll advance via id cursor inside the loop)
  const preCountParams = [];
  const preCountWhere = ['a.sentiment_score IS NULL'];
  if (SINCE) {
    preCountParams.push(SINCE);
    preCountWhere.push(`a.published_at >= $${preCountParams.length}::date`);
  }
  const countRows = await withRetry('pre-count', () => pool.query(
    `SELECT COUNT(*)::bigint AS n FROM news_articles a WHERE ${preCountWhere.join(' AND ')}`,
    preCountParams
  ).then(r => r.rows));
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
  let lastId = resumeLastId;
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

    const rows = await withRetry('SELECT batch', () => pool.query(
      `SELECT a.id, a.title, a.summary, a.translated_title, a.translated_summary
         FROM news_articles a
        WHERE ${whereBits.join(' AND ')}
        ORDER BY a.id ASC
        LIMIT ${fetchLimit}`,
      params
    ).then(r => r.rows));

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
      const result = await withRetry('UPDATE batch', () => pool.query(
        `UPDATE news_articles a
            SET sentiment_score = v.score
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::float8[]) AS score) v
          WHERE a.id = v.id
            AND a.sentiment_score IS NULL`,
        [ids, scores]
      ));
      stats.written += result.rowCount || 0;
    }

    stats.batches++;

    // ── Progress + ETA (every batch) ─────────────────────────────────────
    const target   = LIMIT || totalNull;
    const pctNum   = Math.min(100, (stats.scanned / target) * 100);
    const pct      = pctNum.toFixed(1);
    const elapsed  = Date.now() - stats.startedAt;
    const rate     = stats.scanned / Math.max(0.001, elapsed / 1000);
    const remaining = Math.max(0, target - stats.scanned);
    const etaMs    = rate > 0 ? (remaining / rate) * 1000 : 0;
    const etaHuman = etaMs > 0 ? humanDuration(etaMs) : '—';

    _lastKnown = { lastId, totalNull, eta: etaHuman };
    writeCheckpoint(_lastKnown);

    // Always print every batch in a single terse line — small enough to be
    // unobtrusive, detailed enough to see rate/ETA live.
    // Use \r when not verbose so terminals overwrite the previous line;
    // verbose mode uses \n so you get a full scrollback.
    const barW = 24;
    const filled = Math.round((pctNum / 100) * barW);
    const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
    const line =
      `  ${bar} ${pct.padStart(5)}%  ` +
      `${stats.scanned.toLocaleString().padStart(9)}/${target.toLocaleString()}  ` +
      `w=${stats.written.toLocaleString().padStart(7)}  ` +
      `${rate.toFixed(0).padStart(4)}/s  ` +
      `elapsed ${humanDuration(elapsed)}  eta ${etaHuman}`;

    if (VERBOSE || !process.stdout.isTTY) {
      console.log(line);
    } else {
      process.stdout.write('\r' + line);
    }
  }
  if (!VERBOSE && process.stdout.isTTY) process.stdout.write('\n');

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
  console.log(`   checkpoint   : ${CHECKPOINT_PATH}`);

  clearCheckpoint();
  await pool.end();
}

// Graceful shutdown: leave a final checkpoint so you can resume where you
// stopped. Only writes if we actually made progress.
let _shuttingDown = false;
let _lastKnown = { lastId: 0, totalNull: null }; // updated from the main loop
function gracefulExit(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n⏸  caught ${signal} — writing final checkpoint and exiting…`);
  if (stats.batches > 0) {
    writeCheckpoint(_lastKnown);
    console.log(`   checkpoint saved — resume with: node backfillSentiment.js${DRY ? ' --dry' : ''}`);
  } else {
    console.log('   (no progress yet — nothing to checkpoint)');
  }
  pool.end().finally(() => process.exit(0));
}
process.on('SIGINT',  () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

main().catch(err => {
  if (_shuttingDown) return; // already handling SIGINT/SIGTERM
  console.error('❌ backfill failed:', err);
  if (stats.batches > 0) writeCheckpoint(_lastKnown);
  pool.end().finally(() => process.exit(1));
});
