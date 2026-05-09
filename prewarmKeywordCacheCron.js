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
 *   2. /api/keywords/trending + /api/keywords/rising, merged + deduped.
 *      Trending covers sustained-volume keywords (trump, ukraine, china)
 *      that users hit constantly; rising covers surge keywords (e.g.
 *      "ted turner", "hantavirus-stricken ship") that aren't in the
 *      baseline yet. Both lists are fetched in parallel each tick so
 *      newly-spiking keywords get warmed within an hour AND the high-
 *      traffic baseline never goes cold during quiet periods.
 *      Caps via PREWARM_TRENDING_LIMIT (default 25) and
 *      PREWARM_RISING_LIMIT (default 25); merged total is the union.
 *   3. DEFAULT_KEYWORDS — hand-curated fallback used only when both
 *      keyword endpoints are unreachable (transient keywordCron failure).
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
 *   PREWARM_TRENDING_LIMIT  how many trending keywords to warm (default: 15)
 *   PREWARM_RISING_LIMIT    how many rising keywords to warm (default: 25)
 *   PREWARM_TIMEOUT_MS      per-request timeout (default: 95000)
 *   PREWARM_PAUSE_MS        pause between keyword batches (default: 250)
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

// Per-list caps. Earlier versions warmed only rising (max 40), which
// missed sustained high-traffic keywords ("trump", "ukraine", "china")
// because they weren't gaining momentum — they were already at top.
// We now blend both sources: trending for the steady baseline and
// rising for surge events, deduped at merge time.
// Trending defaults trimmed to 15: sustained-volume keywords like "trump"
// or "ukraine" are the slowest queries on the API (cold buffer + ~150K
// articles in the join) and reliably hit the server's prewarm SQL caps
// (90s heatmap / 60s flows). The top-15 capture nearly all sustained
// search traffic; the long tail can warm organically. Lift to 25+ via
// PREWARM_TRENDING_LIMIT only if pool monitoring shows headroom.
const TRENDING_LIMIT = parseInt(process.env.PREWARM_TRENDING_LIMIT || '15', 10);
const RISING_LIMIT   = parseInt(process.env.PREWARM_RISING_LIMIT   || '25', 10);

// Pause between keywords (ms). Lets pg pool drain between bursts so the
// cron doesn't compete with user-facing traffic for connections. 250ms ×
// ~50 keywords adds ~12s to total runtime — negligible vs the per-keyword
// 5–30s query times.
const INTER_KEYWORD_PAUSE_MS = parseInt(process.env.PREWARM_PAUSE_MS || '250', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Defensive shape filter — drops keywords that are clearly not worth
// warming (or are outright bugs in the upstream extraction pipeline).
// The trending/rising endpoints filter via the stopwords table on the
// DB side, but bad-shape values like the literal string "null" can
// still slip through if the keyword extractor wrote a stringified JS
// null into keyword_daily_stats. This second pass keeps a rogue row
// from burning ~108s of cron + Claude budget on each run.
//
// Rules:
//   - reject "null", "undefined" (literal strings, case-insensitive)
//   - reject < 2 chars after trim (single chars are noise)
//   - reject pure-punctuation / pure-whitespace
//   - everything else passes; real stopword filtering belongs in the
//     stopwords DB table, not here.
const _BAD_SHAPE_RX = /^(null|undefined|nan|none|n\/a|na)$/i;
function _isWarmableKeyword(s) {
  if (!s) return false;
  const trimmed = String(s).trim();
  if (trimmed.length < 2) return false;
  if (_BAD_SHAPE_RX.test(trimmed)) return false;
  if (!/[a-z0-9]/i.test(trimmed)) return false; // no letters/digits at all
  return true;
}

async function fetchKeywordList(path, label) {
  try {
    const r = await fetchWithTimeout(`${API_URL}${path}`);
    if (!r.ok) {
      console.warn(`${TAG} ${label} HTTP ${r.status}`);
      return [];
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data?.keywords || []);
    const before = arr.length;
    const list = arr
      .map(item => item && typeof item.keyword === 'string' ? item.keyword.trim().toLowerCase() : null)
      .filter(Boolean)
      .filter(_isWarmableKeyword);
    if (list.length < before) {
      console.log(`${TAG} ${label}: dropped ${before - list.length} bad-shape keyword(s)`);
    }
    return list;
  } catch (err) {
    console.warn(`${TAG} ${label} fetch failed: ${err.message}`);
    return [];
  }
}

// Resolve the keyword list once per run. Order of preference:
//   1. PREWARM_KEYWORDS env var (manual override — handy for ops or
//      reproducing a specific failure scenario)
//   2. Trending + rising, merged. Trending leads (sustained baseline
//      that organic traffic depends on); rising follows (newly-spiking
//      stories that don't have organic hits yet). Both fetched in
//      parallel; deduped by lowercased keyword.
//   3. DEFAULT_KEYWORDS — hand-curated fallback, used only when BOTH
//      endpoints fail / return empty so a transient outage doesn't
//      leave the entire cache cold.
async function pickKeywordsToWarm() {
  if (process.env.PREWARM_KEYWORDS) {
    const list = process.env.PREWARM_KEYWORDS.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`${TAG} using PREWARM_KEYWORDS env override (${list.length} keywords)`);
    return list;
  }

  const [trendingList, risingList] = await Promise.all([
    fetchKeywordList(`/api/keywords/trending?days=7&limit=${TRENDING_LIMIT}`, '/api/keywords/trending'),
    fetchKeywordList(`/api/keywords/rising?limit=${RISING_LIMIT}`,             '/api/keywords/rising'),
  ]);

  // Merge with dedup. Trending first so steady-volume keywords ride the
  // earlier cron slots — if the cron is killed mid-run we'd rather have
  // warmed "trump" than "tchouaméni".
  const seen = new Set();
  const merged = [];
  for (const k of [...trendingList, ...risingList]) {
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(k);
  }

  if (merged.length) {
    console.log(`${TAG} discovered ${merged.length} keywords (trending=${trendingList.length}, rising=${risingList.length}, dedup_overlap=${trendingList.length + risingList.length - merged.length})`);
    return merged;
  }

  console.warn(`${TAG} both keyword endpoints returned empty — falling back to DEFAULTS`);
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
  // Sequential heatmap → flows. Earlier versions ran both in parallel,
  // which doubled the cron's peak pg-pool footprint to 2 connections per
  // keyword. For sustained-volume keywords like "trump" each query can
  // run 30-60s, so two parallel ones can compete with each other AND
  // with user traffic on the same pool. Sequential keeps the cron at 1
  // connection in flight — the cron runs longer but never spikes load.
  let hmRes, flRes;
  try {
    const ms = await warmHeatmap(keyword);
    hmRes = { ok: true, ms };
  } catch (e) {
    hmRes = { ok: false, err: e?.message || String(e) };
  }
  try {
    const ms = await warmFlows(keyword);
    flRes = { ok: true, ms };
  } catch (e) {
    flRes = { ok: false, err: e?.message || String(e) };
  }
  return {
    keyword,
    heatmap: hmRes.ok ? `${hmRes.ms}ms` : `ERR ${hmRes.err}`,
    flows:   flRes.ok ? `${flRes.ms}ms` : `ERR ${flRes.err}`,
    // Track sub-requests independently so exit-code logic doesn't mark a
    // keyword as a total failure just because ONE of two sub-requests
    // failed (e.g., a hot keyword's flow query times out at the server's
    // 10s SQL cap but its heatmap completes fine — we still warmed
    // something useful, no need to fail the whole cron).
    hmOk:    hmRes.ok,
    flOk:    flRes.ok,
    ok:      hmRes.ok && flRes.ok,
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
    // Brief pause between keyword batches so the API's pg pool can
    // drain. Skipped after the final batch (no point pausing if there's
    // no follow-on work).
    if (INTER_KEYWORD_PAUSE_MS > 0 && i + CONCURRENCY < KEYWORDS.length) {
      await sleep(INTER_KEYWORD_PAUSE_MS);
    }
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
