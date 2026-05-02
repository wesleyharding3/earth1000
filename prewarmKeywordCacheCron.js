#!/usr/bin/env node
'use strict';

/**
 * prewarmKeywordCacheCron.js
 *
 * Hits /api/heatmap and /api/flows for the top news keywords on the
 * standard 7-day window so the in-memory TTL caches stay warm. Both
 * endpoints already cache results (heatmap: 60s + stale-while-revalidate,
 * flows: 600s); this cron just makes sure the user never pays the cold-
 * miss latency for the highest-traffic queries.
 *
 * For "trump" + 7 days the cold latency is ~3–5s on flows and ~1s on
 * heatmap. With this cron running every 5 minutes (recommended cadence
 * given flows' 600s TTL — slightly faster than expiry to bridge any
 * cron drift), the user-facing requests are always cache hits at <10ms.
 *
 * Why HTTP and not direct DB calls:
 *   This script runs as a separate Node process, so it can't share the
 *   in-memory TTL cache with the server. Firing real HTTP requests is
 *   the only way to populate the running server's cache.
 *
 * Env vars:
 *   API_URL              base URL of the API (default: http://localhost:3000)
 *   PREWARM_KEYWORDS     comma-separated keyword list (overrides defaults)
 *   PREWARM_TIMEOUT_MS   per-request timeout (default: 12000)
 *
 * Run:  node prewarmKeywordCacheCron.js
 *
 * Wire to Render Cron / system cron at every 5 minutes:
 *   `* /5 * * * * cd /app && node prewarmKeywordCacheCron.js`
 */

require('dotenv').config({ override: true });

const API_URL     = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
// 60s — cold-buffer flows queries on a hot keyword can take 8–10s, plus
// network RTT. Anything shorter just kills our own in-flight requests
// and looks like a fetch error in the logs.
//
// Bumped 60s → 95s after observing every heatmap call abort at 60s.
// Reason: the heatmap endpoint sets ITS OWN server-side SQL timeout of
// 90s (see server.js _heatmapQuery → SET statement_timeout = 90000),
// which is longer than our previous 60s. We need to wait longer than
// the server is willing to spend, otherwise we cancel its work for it.
// 95s = 90s server cap + 5s network/serialize buffer.
const TIMEOUT_MS  = parseInt(process.env.PREWARM_TIMEOUT_MS || '95000', 10);
// Serialize by default. Concurrency >1 saturates the API's small pg pool
// (each flows query holds a connection for up to 10s under
// SET LOCAL statement_timeout = 10000); follow-on requests then queue
// past our own fetch timeout and abort. Override with PREWARM_CONCURRENCY
// if you've sized the pool generously and tested it.
const CONCURRENCY = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));

// Loud warning when running on a separate host (Render Cron, k8s job, etc.)
// without API_URL set — the default localhost:3000 won't resolve and every
// keyword will fail with ENOTFOUND in milliseconds, looking like a real bug.
if (!process.env.API_URL) {
  console.warn('[prewarm-kw] WARNING: API_URL not set — defaulting to http://localhost:3000.');
  console.warn('[prewarm-kw]          On Render Cron / external schedulers, set API_URL to your API host');
  console.warn('[prewarm-kw]          (e.g. https://earth-wjr6.onrender.com) or every request will fail.');
}

// Default top-30. Hand-curated from typical news traffic; tune via env.
// Lowercased — both endpoints lowercase server-side.
const DEFAULT_KEYWORDS = [
  'trump', 'biden', 'putin', 'xi jinping',
  'ukraine', 'russia', 'china', 'israel', 'gaza', 'iran',
  'north korea', 'taiwan', 'india', 'pakistan',
  'climate', 'ai', 'bitcoin', 'crypto',
  'election', 'inflation', 'fed', 'interest rates',
  'immigration', 'border',
  'supreme court', 'congress',
  'nato', 'eu',
  'oil', 'opec',
];

const KEYWORDS = (process.env.PREWARM_KEYWORDS
  ? process.env.PREWARM_KEYWORDS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_KEYWORDS);

const TAG = '[prewarm-kw]';

function isoDate(d) { return d.toISOString().slice(0, 10); }

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

async function warmHeatmap(keyword) {
  const url = `${API_URL}/api/heatmap?keyword=${encodeURIComponent(keyword)}&days=7&mode=coverage&bucket=none`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  if (!r.ok) throw new Error(`heatmap ${r.status} (${ms}ms)`);
  // Drain the body so the connection closes cleanly; we don't need the data.
  await r.text().catch(() => {});
  return ms;
}

async function warmFlows(keyword) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const url = `${API_URL}/api/flows?mode=aggregate&view_mode=country&limit=500`
            + `&from_date=${isoDate(weekAgo)}&to_date=${isoDate(today)}`
            + `&keyword=${encodeURIComponent(keyword)}`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  if (!r.ok) throw new Error(`flows ${r.status} (${ms}ms)`);
  await r.text().catch(() => {});
  return ms;
}

async function warmOne(keyword) {
  // Run heatmap + flows in parallel — they hit different routes.
  const [hm, fl] = await Promise.allSettled([warmHeatmap(keyword), warmFlows(keyword)]);
  return {
    keyword,
    heatmap: hm.status === 'fulfilled' ? `${hm.value}ms` : `ERR ${hm.reason?.message || hm.reason}`,
    flows:   fl.status === 'fulfilled' ? `${fl.value}ms` : `ERR ${fl.reason?.message || fl.reason}`,
    // Track sub-requests independently so exit-code logic doesn't mark a
    // keyword as a total failure just because ONE of two sub-requests
    // failed (e.g., a hot keyword's flow query times out at the server's
    // 10s SQL cap but its heatmap completes fine — we still warmed
    // something useful, no need to fail the whole cron).
    hmOk:    hm.status === 'fulfilled',
    flOk:    fl.status === 'fulfilled',
    ok:      hm.status === 'fulfilled' && fl.status === 'fulfilled',
  };
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} keywords=${KEYWORDS.length} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  // Process keywords in small batches. Default concurrency is 1 — see
  // the const declaration at the top for why parallelism saturates the
  // API's pg pool and triggers cascading aborts.
  const results = [];
  for (let i = 0; i < KEYWORDS.length; i += CONCURRENCY) {
    const batch = KEYWORDS.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(warmOne));
    results.push(...out);
  }

  const okCount   = results.filter(r => r.ok).length;
  const partialOk = results.filter(r => !r.ok && (r.hmOk || r.flOk)).length;
  const hmOkCount = results.filter(r => r.hmOk).length;
  const flOkCount = results.filter(r => r.flOk).length;
  const allFail   = results.filter(r => !r.hmOk && !r.flOk).length;
  for (const r of results) {
    console.log(`${TAG}   ${r.keyword.padEnd(16)} hm=${r.heatmap.padEnd(12)} fl=${r.flows}`);
  }
  console.log(`${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — full_ok=${okCount} partial=${partialOk} hm_ok=${hmOkCount}/${results.length} fl_ok=${flOkCount}/${results.length}`);

  // Non-zero exit ONLY if every sub-request of every keyword failed —
  // i.e. zero useful work happened. A run where heatmap timed out but
  // flows succeeded is still a productive cache-warmer; don't paint
  // the cron service red over partial failures.
  if (results.length > 0 && hmOkCount === 0 && flOkCount === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
