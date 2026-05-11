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
const { forceRefreshCaches, cacheBust, purgeCloudflareUrls } = require('./prewarmCommon');

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

// Hand-curated keep-warm list. ALWAYS merged into the warm set on top
// of trending+rising — these are the high-leverage searches the user
// reaches for whether or not they're trending right now. Categories:
//   • US politicians, cabinet, top global heads of state
//   • Active conflict regions + actors
//   • Major economic terms (markets, energy, crypto)
//   • Tech (AI labs, chip names, household tech names)
//   • Recurring multilateral bodies + alliances
//   • Climate / energy / health (slow-burn topics)
//
// Bumped 30 → ~140 after observing that the prior 39-keyword warm pool
// (15 trending + 25 rising - overlap) missed obvious staples whenever
// they fell off the live trending/rising lists for a few hours. The
// extra ~100 entries are almost all fast-tail keywords (sub-2s queries)
// since the slowest pool is the sustained-volume ones already in
// trending. Net effect on run time: +60-120s versus a clean run; well
// within the hourly cron budget.
//
// Lowercased — both /heatmap and /flows lowercase server-side.
const KEEP_WARM = [
  // ── US politics: principals + cabinet + opposition ────────────
  'trump', 'donald trump', 'biden', 'joe biden', 'kamala harris',
  'jd vance', 'marco rubio', 'pete hegseth', 'pam bondi', 'robert kennedy jr',
  'tulsi gabbard', 'elise stefanik', 'mike johnson', 'chuck schumer',
  'mitch mcconnell', 'nancy pelosi', 'aoc', 'ted cruz', 'ron desantis',
  'supreme court', 'congress', 'senate', 'house of representatives',
  // ── World heads of state / power players ──────────────────────
  'putin', 'vladimir putin', 'xi jinping', 'modi', 'narendra modi',
  'netanyahu', 'benjamin netanyahu', 'zelensky', 'volodymyr zelensky',
  'kim jong un', 'macron', 'emmanuel macron', 'starmer', 'keir starmer',
  'meloni', 'erdogan', 'mohammed bin salman', 'mbs', 'lula',
  'orban', 'milei', 'sheinbaum', 'al-sharaa',
  // ── Active conflicts / hot regions ────────────────────────────
  'ukraine', 'russia', 'ukraine war', 'crimea', 'donbas',
  'israel', 'gaza', 'west bank', 'palestine', 'hamas', 'hezbollah',
  'lebanon', 'syria', 'yemen', 'houthi',
  'iran', 'iraq', 'tehran',
  'sudan', 'rsf', 'sahel', 'mali', 'niger', 'burkina faso',
  'china', 'taiwan', 'south china sea', 'taiwan strait',
  'north korea', 'south korea',
  'india', 'pakistan', 'kashmir',
  // ── Multilateral bodies + alliances ───────────────────────────
  'nato', 'european union', 'eu', 'united nations', 'un',
  'g7', 'g20', 'brics', 'opec', 'wto', 'imf', 'world bank',
  'african union',
  // ── Economy / markets ─────────────────────────────────────────
  'inflation', 'recession', 'fed', 'federal reserve', 'interest rates',
  'tariffs', 'trade war', 'stock market', 's&p 500', 'nasdaq', 'dow jones',
  'oil', 'energy', 'gold', 'gas prices',
  'bitcoin', 'crypto', 'ethereum',
  // ── Tech / AI / semis ─────────────────────────────────────────
  'ai', 'artificial intelligence', 'chatgpt', 'openai', 'sam altman',
  'anthropic', 'claude', 'gemini', 'meta',
  'nvidia', 'tsmc', 'semiconductors', 'chips',
  'apple', 'google', 'microsoft', 'tesla', 'spacex', 'elon musk',
  // ── Climate / health / disasters ──────────────────────────────
  'climate', 'climate change', 'global warming', 'cop',
  'wildfire', 'hurricane', 'flood', 'drought', 'earthquake', 'tsunami',
  'emissions', 'renewable energy',
  'pandemic', 'covid', 'avian flu', 'bird flu', 'mpox',
  // ── Recurring categories users search for ─────────────────────
  'election', 'protest', 'sanctions', 'cyberattack',
  'immigration', 'border', 'asylum', 'refugees',
  'summit', 'ceasefire', 'peace talks',
];

// Used only when BOTH /trending and /rising are unreachable. KEEP_WARM
// already covers the cold-start case, but this kept the historic
// constant name + a small subset so any external runbooks that grep
// for DEFAULT_KEYWORDS still find something sensible.
const DEFAULT_KEYWORDS = KEEP_WARM.slice(0, 30);

// Per-list caps. Earlier versions warmed only rising (max 40), which
// missed sustained high-traffic keywords ("trump", "ukraine", "china")
// because they weren't gaining momentum — they were already at top.
// We now blend both sources PLUS a hand-curated KEEP_WARM list (see
// above). Order of preference: KEEP_WARM → trending → rising, deduped
// at merge time.
//
// Trending: bumped 15 → 25 so we capture the FULL top-of-list pool
// each tick. The slowest sustained-volume keywords still come from
// here, but adding the next 10 doesn't materially extend total run
// time — those next 10 are sub-5s queries, not 30-60s monsters.
//
// Rising: stayed at 25 — beyond that point you're paying for sub-100ms
// queries that probably don't have organic traffic anyway, and we
// already cover the hand-curated baseline via KEEP_WARM.
const TRENDING_LIMIT = parseInt(process.env.PREWARM_TRENDING_LIMIT || '25', 10);
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
//   2. KEEP_WARM (hand-curated baseline) + trending + rising,
//      merged + deduped. Order matters: KEEP_WARM leads so sustained
//      high-traffic keywords ride the earlier cron slots — if the
//      cron is killed mid-run we'd rather have warmed "trump" than
//      "tchouaméni". Trending then rising on top.
//   3. DEFAULT_KEYWORDS — used only when BOTH endpoints fail AND
//      KEEP_WARM is somehow empty (shouldn't happen, but kept for
//      safety so a cascading API outage doesn't break the cron).
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

  // KEEP_WARM first (every cron must touch these) then trending then
  // rising. Lowercase + dedup at merge. Anything bad-shape (e.g. an
  // empty string snuck into KEEP_WARM) is filtered by the same
  // _isWarmableKeyword used on API output.
  const seen = new Set();
  const merged = [];
  for (const k of [...KEEP_WARM, ...trendingList, ...risingList]) {
    const lc = String(k || '').trim().toLowerCase();
    if (!lc || seen.has(lc)) continue;
    if (!_isWarmableKeyword(lc)) continue;
    seen.add(lc);
    merged.push(lc);
  }

  if (merged.length) {
    const apiCount = trendingList.length + risingList.length;
    console.log(`${TAG} discovered ${merged.length} keywords (keep_warm=${KEEP_WARM.length}, trending=${trendingList.length}, rising=${risingList.length}, dedup_overlap=${KEEP_WARM.length + apiCount - merged.length})`);
    return merged;
  }

  console.warn(`${TAG} keyword endpoints empty AND KEEP_WARM empty — falling back to DEFAULTS`);
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
  // Cache-bust so Cloudflare passes through to origin. CF purge for the
  // canonical URL happens at end-of-run.
  const r = await fetchWithTimeout(cacheBust(url));
  const ms = Date.now() - t0;
  // Cancel body — server cache is populated before res.json() runs,
  // so we don't need to download the heatmap payload (large JSON).
  try { await r.body?.cancel?.(); } catch {}
  if (!r.ok) throw new Error(`heatmap ${r.status} (${ms}ms)`);
  return { ms, url };
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
  const r = await fetchWithTimeout(cacheBust(url));
  const ms = Date.now() - t0;
  try { await r.body?.cancel?.(); } catch {}
  if (!r.ok) throw new Error(`flows ${r.status} (${ms}ms)`);
  return { ms, url };
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
    const r = await warmHeatmap(keyword);
    hmRes = { ok: true, ms: r.ms, url: r.url };
  } catch (e) {
    hmRes = { ok: false, err: e?.message || String(e) };
  }
  try {
    const r = await warmFlows(keyword);
    flRes = { ok: true, ms: r.ms, url: r.url };
  } catch (e) {
    flRes = { ok: false, err: e?.message || String(e) };
  }
  return {
    keyword,
    heatmap: hmRes.ok ? `${hmRes.ms}ms` : `ERR ${hmRes.err}`,
    flows:   flRes.ok ? `${flRes.ms}ms` : `ERR ${flRes.err}`,
    hmUrl:   hmRes.url,
    flUrl:   flRes.url,
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

  // Force-evict the heatmap + flow caches so the warmer's GETs below
  // cache-miss and repopulate from current DB state. This cron runs
  // hourly, so without eviction we'd just touch the existing 65m-TTL
  // entries without ever refreshing them.
  await forceRefreshCaches({
    apiUrl: API_URL,
    prefixes: ['heatmap:', 'flows:'],
    tag: TAG,
  });

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

  // Purge Cloudflare cache for the canonical /api/heatmap and /api/flows
  // URLs we just warmed. See prewarmCommon.js for full rationale.
  const canonicalUrls = results.flatMap(r => [r.hmUrl, r.flUrl]).filter(Boolean);
  await purgeCloudflareUrls({ urls: canonicalUrls, tag: TAG });

  // Non-zero exit ONLY if every keyword sub-request failed.
  const anyOk = hmOkCount > 0 || flOkCount > 0;
  if (results.length > 0 && !anyOk) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
