#!/usr/bin/env node
'use strict';

/**
 * prewarmThreadFlowsCron.js
 *
 * Pre-warms /api/flows/thread/:id and /api/flows/timeline/:id for the
 * top active+cooling threads and timelines. Runs at the thread builder's
 * cadence (every 2 hours) so the flow-arc cache (TTL 1h45m) is always
 * warm when the user taps a card.
 *
 * Why pure HTTP, no DB pool: production was hitting Postgres connection
 * cap ("remaining connection slots are reserved for roles with the
 * SUPERUSER attribute" — error 53300) when crons opened their own pg
 * pools. So this cron discovers the top-N items via /api/threads/latest
 * and /api/timelines/latest, which are themselves cached, and pays no
 * direct PG connection. Mirrors the all-HTTP pattern of
 * prewarmKeywordCacheCron.js.
 *
 * Env vars:
 *   API_URL                    base URL of the API (default: http://localhost:3000)
 *   PREWARM_THREAD_LIMIT       override top-N threads (default: 50)
 *   PREWARM_TIMELINE_LIMIT     override top-N timelines (default: 20)
 *   PREWARM_TIMEOUT_MS         per-request timeout (default: 95000 — matches
 *                              heatmap's 90s server-side SQL timeout + 5s buffer)
 *   PREWARM_CONCURRENCY        parallel requests (default: 1)
 *
 * Run:
 *   node prewarmThreadFlowsCron.js
 *
 * Wire to a 2h Render Cron:
 *   `5 *\/2 * * * cd /app && node prewarmThreadFlowsCron.js`
 */

require('dotenv').config({ override: true });

const API_URL        = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS     = parseInt(process.env.PREWARM_TIMEOUT_MS    || '95000', 10);
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

async function fetchJSON(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Top items via /api/{threads,timelines}/latest — these endpoints already
// rank by importance × article_count and apply the active/cooling filter,
// which is exactly what we want to prewarm.
async function pickTopThreads(n) {
  const data = await fetchJSON(`${API_URL}/api/threads/latest?limit=${n}`);
  const arr = Array.isArray(data) ? data : (data?.threads || data?.data || []);
  return arr.slice(0, n).map(t => ({
    id: t.thread_id || t.id,
    title: t.title,
    importance: t.importance,
    article_count: t.article_count,
  })).filter(t => t.id);
}

async function pickTopTimelines(n) {
  const data = await fetchJSON(`${API_URL}/api/timelines/latest?limit=${n}`);
  const arr = Array.isArray(data) ? data : (data?.timelines || data?.data || []);
  return arr.slice(0, n).map(t => ({
    id: t.timeline_id || t.id,
    title: t.title,
    importance: t.importance,
    article_count: t.article_count,
  })).filter(t => t.id);
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

  let threads = [], timelines = [];
  try {
    [threads, timelines] = await Promise.all([
      pickTopThreads(THREAD_LIMIT),
      pickTopTimelines(TIMELINE_LIMIT),
    ]);
  } catch (err) {
    console.error(`${TAG} fatal: discovery failed (${err.message}). Verify API_URL is reachable.`);
    process.exit(1);
  }
  console.log(`${TAG} loaded ${threads.length} threads + ${timelines.length} timelines\n`);

  const threadResults   = await processBatch(threads,   'thread');
  console.log('');
  const timelineResults = await processBatch(timelines, 'timeline');

  const tOk = threadResults.filter(r => !r.err).length;
  const lOk = timelineResults.filter(r => !r.err).length;
  const totalMs = [...threadResults, ...timelineResults].reduce((s, r) => s + (r.ms || 0), 0);

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — threads_ok=${tOk}/${threadResults.length} timelines_ok=${lOk}/${timelineResults.length} total_query_ms=${totalMs}`);

  // Non-zero exit only on catastrophic failure (every single sub-request
  // failed). Partial failures are normal — one slow item shouldn't turn
  // the cron service red.
  const totalCount = threadResults.length + timelineResults.length;
  const totalOk    = tOk + lOk;
  if (totalCount > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
