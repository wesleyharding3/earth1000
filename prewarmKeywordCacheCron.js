#!/usr/bin/env node
'use strict';

/**
 * prewarmKeywordCacheCron.js
 *
 * Hits /api/heatmap and /api/flows for the keywords with the highest
 * recent momentum on the standard 7-day window so the in-memory TTL
 * caches stay warm. Both endpoints' TTLs (heatmap and flows-keyword
 * are both 65 min) are deliberately aligned with this cron's HOURLY
 * cadence so each tick lands on a near-expiry cache and refreshes
 * it — the user never pays the cold-miss latency.
 *
 * Keyword source (rolling, in order of preference):
 *   1. PREWARM_KEYWORDS env var — manual override, ops/debug only
 *   2. /api/keywords/rising?limit=N — the live, momentum-ranked list
 *      (default N=40, override via PREWARM_RISING_LIMIT). Resolved on
 *      every cron tick so newly-spiking keywords get warmed within a
 *      cycle and ones that have cooled off automatically drop out.
 *   3. DEFAULT_KEYWORDS — hand-curated fallback used only when the
 *      rising endpoint is unreachable (transient keywordCron failure).
 *
 * For "trump" + 7 days the cold latency is ~3–5s on flows and ~1s on
 * heatmap. With this cron running every 60 minutes and both endpoint
 * caches set to 65 min TTL (5 min drift buffer), the user-facing
 * requests are always cache hits at <10ms.
 *
 * Why HTTP and not direct DB calls:
 *   This script runs as a separate Node process, so it can't share the
 *   in-memory TTL cache with the server. Firing real HTTP requests is
 *   the only way to populate the running server's cache.
 *
 * Env vars:
 *   API_URL                 base URL of the API (default: http://localhost:3000)
 *   PREWARM_KEYWORDS        comma-separated keyword list (manual override)
 *   PREWARM_RISING_LIMIT    how many rising keywords to warm (default: 40)
 *   PREWARM_TIMEOUT_MS      per-request timeout (default: 95000)
 *
 * Run:  node prewarmKeywordCacheCron.js
 *
 * Wire to Render Cron / system cron once per hour, e.g. at :00:
 *   `0 * * * * cd /app && node prewarmKeywordCacheCron.js`
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

// Hand-curated fallback list. Used only when the rising-keywords API is
// unreachable / empty (e.g. keywordCron.js failed and the DB cache is
// stale). Lowercased — both endpoints lowercase server-side.
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

// Top-N rising keywords to warm. The cron used to read a 30-entry
// curated list (DEFAULT_KEYWORDS above) which went stale fast — newly-
// spiking stories ("hormuz", "rubio vatican") had cold caches because
// they weren't on the list, while keywords that had cooled off
// ("interest rates" in a quiet week) wasted cron cycles. Now we read
// from the rising endpoint each run, so warming naturally tracks
// what users are most likely to search for.
const RISING_LIMIT = parseInt(process.env.PREWARM_RISING_LIMIT || '40', 10);

// Resolve the keyword list once per run. Order of preference:
//   1. PREWARM_KEYWORDS env var (manual override — handy for ops or
//      reproducing a specific failure scenario)
//   2. Top-N rising keywords from /api/keywords/rising — the live,
//      rolling source. New high-momentum keywords appear here as soon
//      as keywordCron.js's next refresh writes them; old ones drop
//      out automatically when their momentum decays.
//   3. DEFAULT_KEYWORDS — hand-curated fallback, used only when
//      rising is unreachable / empty so a transient outage doesn't
//      leave the entire cache cold.
async function pickKeywordsToWarm() {
  if (process.env.PREWARM_KEYWORDS) {
    const list = process.env.PREWARM_KEYWORDS.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`${TAG} using PREWARM_KEYWORDS env override (${list.length} keywords)`);
    return list;
  }
  try {
    const r = await fetchWithTimeout(`${API_URL}/api/keywords/rising?limit=${RISING_LIMIT}`);
    if (r.ok) {
      const data = await r.json();
      const arr = Array.isArray(data) ? data : (data?.keywords || []);
      const list = arr
        .map(item => item && typeof item.keyword === 'string' ? item.keyword.trim().toLowerCase() : null)
        .filter(Boolean);
      if (list.length) {
        console.log(`${TAG} discovered ${list.length} rising keywords from /api/keywords/rising`);
        return list;
      }
      console.warn(`${TAG} /api/keywords/rising returned empty — falling back to DEFAULTS`);
    } else {
      console.warn(`${TAG} /api/keywords/rising HTTP ${r.status} — falling back to DEFAULTS`);
    }
  } catch (err) {
    console.warn(`${TAG} /api/keywords/rising fetch failed: ${err.message} — falling back to DEFAULTS`);
  }
  return DEFAULT_KEYWORDS;
}

const TAG = '[prewarm-kw]';

function isoDate(d) { return d.toISOString().slice(0, 10); }

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

// NOTE: feed-surface warming (articles/recent, news/search, country/city
// feeds) lives in prewarmFeedCron.js (hourly, matches article fetcher
// cadence). This cron stays focused on keyword heatmap + flows only.

async function warmHeatmap(keyword) {
  // prewarm=1 — server bumps SQL timeout 30s → 60s for this request only.
  // User-facing requests stay capped at 30s.
  const url = `${API_URL}/api/heatmap?keyword=${encodeURIComponent(keyword)}&days=7&mode=coverage&bucket=none&prewarm=1`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  // Cancel body — server cache is populated before res.json() runs,
  // so we don't need to download the heatmap payload (large JSON).
  try { await r.body?.cancel?.(); } catch {}
  if (!r.ok) throw new Error(`heatmap ${r.status} (${ms}ms)`);
  return ms;
}

async function warmFlows(keyword) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  // prewarm=1 — server bumps SQL timeout 30s → 60s for this request only.
  // User-facing requests stay capped at 30s.
  const url = `${API_URL}/api/flows?mode=aggregate&view_mode=country&limit=500`
            + `&from_date=${isoDate(weekAgo)}&to_date=${isoDate(today)}`
            + `&keyword=${encodeURIComponent(keyword)}&prewarm=1`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  try { await r.body?.cancel?.(); } catch {}
  if (!r.ok) throw new Error(`flows ${r.status} (${ms}ms)`);
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
  // Resolve the keyword list per-run so each cycle picks up the latest
  // rising set. KEYWORDS used to be a module-level constant (curated
  // list); now it's dynamic so warming follows real momentum.
  const KEYWORDS = await pickKeywordsToWarm();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} keywords=${KEYWORDS.length} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  console.log(`${TAG} keywords: warming ${KEYWORDS.length} keyword × (heatmap, flows)…`);
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
  console.log(`${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — kw_full_ok=${okCount} kw_partial=${partialOk} hm_ok=${hmOkCount}/${results.length} fl_ok=${flOkCount}/${results.length}`);

  // Non-zero exit ONLY if every keyword sub-request failed.
  const anyOk = hmOkCount > 0 || flOkCount > 0;
  if (results.length > 0 && !anyOk) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
