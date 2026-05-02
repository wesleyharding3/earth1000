#!/usr/bin/env node
'use strict';

/**
 * prewarmThreadFlowsCron.js
 *
 * Pre-warms /api/flows/thread/:id and /api/flows/timeline/:id for the
 * top active+cooling threads and timelines by importance × article
 * volume. Runs at the thread builder's cadence (every 2 hours) so the
 * flow-arc cache (TTL 1h45m) is always warm when the user taps a card.
 *
 * Why this matters: when a user clicks a thread, the globe needs to draw
 * its flow arcs. Cold-cache fetch + the multi-CTE _buildTieredFlows query
 * is the bulk of the perceived "arc lag". Cache miss on a popular thread
 * costs every user 1–3s of pre-render delay; hitting the same threads on
 * a cron schedule absorbs that cost in the background.
 *
 * What gets prewarmed:
 *   • Top THREAD_LIMIT threads (default 50) — status in (active, cooling),
 *     ranked by importance DESC × article_count DESC.
 *   • Top TIMELINE_LIMIT timelines (default 20) — same predicate.
 *
 * Cadence: ideally run every 2h (matches thread builder). Cache TTL is
 * 1h45m so each run refreshes the cache cleanly before it can expire.
 *
 * Env vars:
 *   API_URL                    base URL of the API (default: http://localhost:3000)
 *   PREWARM_THREAD_LIMIT       override top-N threads (default: 50)
 *   PREWARM_TIMELINE_LIMIT     override top-N timelines (default: 20)
 *   PREWARM_TIMEOUT_MS         per-request timeout (default: 60000)
 *   PREWARM_CONCURRENCY        parallel requests (default: 1)
 *
 * Run:
 *   node prewarmThreadFlowsCron.js
 *
 * Wire to a 2h Render Cron / system cron:
 *   `0 *\/2 * * * cd /app && node prewarmThreadFlowsCron.js`
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');

const API_URL        = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS     = parseInt(process.env.PREWARM_TIMEOUT_MS    || '60000', 10);
const CONCURRENCY    = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY    || '1',  10));
const THREAD_LIMIT   = Math.max(1, parseInt(process.env.PREWARM_THREAD_LIMIT   || '50', 10));
const TIMELINE_LIMIT = Math.max(1, parseInt(process.env.PREWARM_TIMELINE_LIMIT || '20', 10));

const TAG = '[prewarm-thread-flows]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Top threads by recent relevance: status filter is the same as
// /api/threads/latest (active + cooling), ranking mirrors importance ×
// article volume so a 9-importance / 200-article thread wins over a
// 9-importance / 5-article one.
async function pickTopThreads(n) {
  const { rows } = await pool.query(`
    SELECT id, title, importance, article_count
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= 2
       AND COALESCE(scope, 'global') = 'global'
     ORDER BY importance DESC NULLS LAST,
              article_count DESC
     LIMIT $1
  `, [n]);
  return rows;
}

async function pickTopTimelines(n) {
  const { rows } = await pool.query(`
    SELECT id, title, importance, article_count
      FROM story_timelines
     WHERE status IN ('active','cooling')
       AND article_count >= 2
     ORDER BY importance DESC NULLS LAST,
              article_count DESC
     LIMIT $1
  `, [n]);
  return rows;
}

async function warmFlow(kind, id) {
  const url = `${API_URL}/api/flows/${kind}/${id}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    return { kind, id, ms: Date.now() - t0, err: e.message };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { kind, id, ms, err: `HTTP ${res.status}` };
  await res.text().catch(() => {});
  return { kind, id, ms };
}

async function processBatch(items, kind) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(it => warmFlow(kind, it.id).then(r => ({ ...r, item: it }))));
    results.push(...out);
    for (const r of out) {
      const tag = r.err ? `ERR ${r.err}` : `${r.ms}ms`;
      const titleTrim = (r.item.title || '').slice(0, 60);
      console.log(`${TAG}   ${kind} #${String(r.id).padStart(6)} imp=${r.item.importance} arts=${String(r.item.article_count).padStart(4)} [${tag}] ${titleTrim}`);
    }
  }
  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} threads=${THREAD_LIMIT} timelines=${TIMELINE_LIMIT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  const [threads, timelines] = await Promise.all([
    pickTopThreads(THREAD_LIMIT),
    pickTopTimelines(TIMELINE_LIMIT),
  ]);
  console.log(`${TAG} loaded ${threads.length} threads + ${timelines.length} timelines\n`);

  const threadResults   = await processBatch(threads,   'thread');
  console.log('');
  const timelineResults = await processBatch(timelines, 'timeline');

  const tOk = threadResults.filter(r => !r.err).length;
  const tErr = threadResults.length - tOk;
  const lOk = timelineResults.filter(r => !r.err).length;
  const lErr = timelineResults.length - lOk;
  const totalMs = [...threadResults, ...timelineResults].reduce((s, r) => s + (r.ms || 0), 0);

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — threads_ok=${tOk}/${threadResults.length} timelines_ok=${lOk}/${timelineResults.length} total_query_ms=${totalMs}`);

  // Non-zero exit only on catastrophic failure (everything failed → API down).
  if (tOk === 0 && lOk === 0 && (threadResults.length + timelineResults.length) > 0) process.exit(1);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
