#!/usr/bin/env node
'use strict';

/**
 * prewarmCountryFlowsCron.js
 *
 * Once-daily long-running job that pre-warms /api/flows responses for
 * the top 50 most-relevant countries, both as `about_country` (flows TO
 * the country) and `from_country` (flows FROM the country). These are
 * the queries that hit cold-DB latency hardest — Indonesia, India, US,
 * Russia all aggregate against millions of article_locations rows and
 * regularly bump the 45s client timeout.
 *
 * Companion to prewarmKeywordCacheCron.js (keyword pre-warming) and
 * prewarmThreadFlowsCron.js (thread/timeline flow pre-warming). All three
 * are pure-HTTP — no direct PG connection. Production was hitting
 * Postgres connection cap when crons opened pg pools (error 53300:
 * "remaining connection slots are reserved for roles with the SUPERUSER
 * attribute"), so this discovers the country list via /api/countries/all
 * (which is itself cached 24h) and never touches the DB directly.
 *
 * Country selection: a curated list of the top-50 ISOs by typical news
 * mention volume — ordered roughly by 30-day article frequency in the
 * earth00 corpus. Stable enough that the static list works fine; if you
 * need to retune, just edit DEFAULT_TOP_ISOS below or override via
 * PREWARM_COUNTRY_ISOS env var.
 *
 * Cadence: daily, paired with /api/flows TTL of 22h for country-only
 * queries (set in server.js). Matches the cron cadence so the cache is
 * always warm when users tap.
 *
 * Env vars:
 *   API_URL                    base URL of the API (default: http://localhost:3000)
 *   PREWARM_COUNTRY_LIMIT      override top-N count (default: 50)
 *   PREWARM_COUNTRY_ISOS       comma-separated ISO list to override defaults
 *   PREWARM_TIMEOUT_MS         per-request timeout (default: 95000)
 *   PREWARM_CONCURRENCY        parallel requests (default: 1, serialize)
 *
 * Run:
 *   node prewarmCountryFlowsCron.js
 *
 * Wire to a daily Render Cron / system cron:
 *   `35 4 * * * cd /app && node prewarmCountryFlowsCron.js`
 */

require('dotenv').config({ override: true });

const API_URL     = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS  = parseInt(process.env.PREWARM_TIMEOUT_MS  || '95000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));
const TOP_N       = Math.max(1, parseInt(process.env.PREWARM_COUNTRY_LIMIT || '100', 10));

const TAG = '[prewarm-countries]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

// Top-100 ISO codes by typical news mention volume, hand-curated for
// stability. Tunable per-run via PREWARM_COUNTRY_ISOS env var. The
// first 50 are the obvious heavy-traffic ones; the next 50 widen
// long-tail coverage (smaller European states, sub-Saharan Africa,
// Central America, more of South + Central Asia + SE Asia) so users
// tapping a less-popular country still hit warm cache.
const DEFAULT_TOP_ISOS = [
  // Top 50 — bulk of news traffic
  'US','GB','RU','CN','IR','IL','UA','IN','DE','FR',
  'BR','JP','IT','ES','MX','CA','AU','KR','TR','NG',
  'ZA','EG','SA','PK','ID','AR','PL','NL','SE','CH',
  'AE','QA','KW','SY','LB','IQ','AF','YE','JO','OM',
  'GR','KE','ET','MA','VE','CO','PE','TH','VN','PH',

  // 51-100 — long-tail coverage
  // Europe
  'PT','IE','BE','AT','NO','DK','FI','CZ','RO','HU',
  'RS','HR','BG','SK','LT','LV','EE','IS',
  // Asia + Pacific
  'HK','TW','BD','MM','LK','NP','KZ','MY','NZ',
  // Middle East / Africa
  'BH','DZ','TN','LY','SD','GH','SN','UG','TZ','ZW',
  'AO','MZ',
  // Americas + Caribbean
  'CL','EC','BO','GT','HN','CR','PA','DO','JM','CU','HT',
];

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

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Resolve ISO → country_id via /api/countries/all (server-cached 24h, so
// this is one cheap HTTP call per cron run).
async function resolveIsoMap() {
  // Endpoint is /api/countries (not /api/countries/all — that path 404s).
  // The internal in-process cache key is 'countries:all', which is what
  // confused me — that's the cache key, not the URL.
  const data = await fetchJSON(`${API_URL}/api/countries`);
  const arr = Array.isArray(data) ? data : (data?.countries || data?.data || []);
  const map = new Map();
  for (const c of arr) {
    const iso = String(c.iso_code || c.iso || '').toUpperCase();
    const id  = c.id;
    if (iso && id) map.set(iso, { id, name: c.name || iso });
  }
  return map;
}

// How many top cities to warm per run. Cities are way more numerous than
// countries (~hundreds), so we cap to keep the cron under Render's 30min
// budget. Top-N picked by population (a proxy for "user is most likely
// to tap this city").
// 50 default — covers all major metros plus a meaningful long tail. Tunable
// with PREWARM_CITY_LIMIT env var. Each city adds 2 requests (local + global
// feed); 50 cities = 100 requests, ~5 min sequential at 3s avg.
const CITY_LIMIT = Math.max(0, parseInt(process.env.PREWARM_CITY_LIMIT || '50', 10));

// Pull the top-N cities by population from /api/cities (24h-cached, cheap).
async function pickTopCities(n) {
  if (n <= 0) return [];
  const data = await fetchJSON(`${API_URL}/api/cities`);
  const arr = Array.isArray(data) ? data : (data?.cities || data?.data || []);
  return arr
    .filter(c => c && c.id)
    .sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0))
    .slice(0, n)
    .map(c => ({ id: c.id, name: c.name, population: c.population || 0 }));
}

// Warm a single feed endpoint and return its timing.
async function warmFeed(label, url) {
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(url);
    const ms = Date.now() - t0;
    if (!r.ok) return { label, ms, err: `HTTP ${r.status}` };
    await r.text().catch(() => {});
    return { label, ms };
  } catch (e) {
    return { label, ms: Date.now() - t0, err: e.message };
  }
}

function pickIsos() {
  if (process.env.PREWARM_COUNTRY_ISOS) {
    return process.env.PREWARM_COUNTRY_ISOS
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return DEFAULT_TOP_ISOS.slice(0, TOP_N);
}

// /api/flows runs two completely different SQL queries depending on mode:
//   aggregate  — grouped by (src,dst) with COUNT — limit 500 — used by the
//                summary-arc view of the news flows panel.
//   individual — raw flow rows with timestamps — limit 2000 — used by the
//                Time Series animation. This is what the panel defaults to.
// They have different cache keys, so warming one doesn't help the other.
// We warm both per (country, direction) — 4 requests per country.
const MODES = [
  { name: 'aggregate',  limit: '500'  },
  { name: 'individual', limit: '2000' },
];

async function warmFlow(direction, country, mode) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    mode:        mode.name,
    view_mode:   'country',
    limit:       mode.limit,
    from_date:   isoDate(weekAgo),
    to_date:     isoDate(today),
    [direction === 'about' ? 'about_country' : 'from_country']: String(country.id),
    // Tell the server we're a prewarm — it bumps SQL timeout 30s → 60s.
    // Top-mention countries' about-direction queries can take 40–55s on
    // cold buffer; user-facing requests stay capped at 30s.
    prewarm:     '1',
  });
  const url = `${API_URL}/api/flows?${params.toString()}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    return { direction, mode: mode.name, country, ms: Date.now() - t0, err: e.message };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { direction, mode: mode.name, country, ms, err: `HTTP ${res.status}` };
  await res.text().catch(() => {});
  return { direction, mode: mode.name, country, ms };
}

async function processOne(country) {
  // 4 sub-requests per country: (about, from) × (aggregate, individual).
  // Run all 4 in parallel — they hit different cache keys, no pool
  // conflict (each runs in its own pg connection with its own
  // statement_timeout). Within-country parallelism keeps run time
  // reasonable: 50 countries × 4 requests × ~10s avg sequenced =
  // ~33min. With 4-way parallelism per country: 50 × ~10s = ~8min.
  const tasks = [];
  for (const dir of ['about', 'from']) {
    for (const mode of MODES) {
      tasks.push(warmFlow(dir, country, mode));
    }
  }
  const results = await Promise.allSettled(tasks);
  const out = { country, results: {} };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const k = `${r.value.direction}/${r.value.mode}`;
      out.results[k] = r.value.err ? { err: r.value.err, ms: r.value.ms } : { ms: r.value.ms };
    } else {
      // shouldn't happen — warmFlow catches and returns
      out.results['?'] = { err: r.reason?.message || 'unknown', ms: 0 };
    }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} top=${TOP_N} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  let isoMap;
  try {
    isoMap = await resolveIsoMap();
  } catch (err) {
    console.error(`${TAG} fatal: countries/all fetch failed (${err.message}). Verify API_URL is reachable.`);
    process.exit(1);
  }

  const requestedIsos = pickIsos();
  const countries = requestedIsos
    .map(iso => {
      const m = isoMap.get(iso);
      return m ? { iso, id: m.id, name: m.name } : null;
    })
    .filter(Boolean);

  if (!countries.length) {
    console.log(`${TAG} no countries resolved — exiting`);
    return;
  }
  const missing = requestedIsos.filter(iso => !isoMap.has(iso));
  if (missing.length) {
    console.warn(`${TAG} skipped ${missing.length} unresolved ISOs: ${missing.join(',')}`);
  }
  console.log(`${TAG} resolved ${countries.length} countries: ${countries.map(c => c.iso).join(',')}`);

  // Phase 0 — warm /api/timelines/latest (22h TTL, daily timeline
  // builder — cadence matches this cron).
  console.log(`${TAG} core feed: warming /api/timelines/latest…`);
  let coreOk = 0;
  try {
    const tl0 = Date.now();
    const tlRes = await fetchWithTimeout(`${API_URL}/api/timelines/latest`);
    const tlMs = Date.now() - tl0;
    if (tlRes.ok) { coreOk = 1; console.log(`${TAG}   /api/timelines/latest [${tlMs}ms]`); }
    else { console.log(`${TAG}   /api/timelines/latest [ERR HTTP ${tlRes.status} (${tlMs}ms)]`); }
    await tlRes.text().catch(() => {});
  } catch (e) {
    console.log(`${TAG}   /api/timelines/latest [ERR ${e.message}]`);
  }
  console.log('');

  // Phase 1 — country feeds (local + global) for the same top-50 set.
  // 100 requests, but each is cheap (60s in-process cache means a single
  // SQL run per country per cron). Sequential to keep pool gentle.
  console.log(`${TAG} country feeds: warming local + global for ${countries.length} countries…`);
  let countryFeedOk = 0;
  for (const c of countries) {
    const local  = await warmFeed('local',  `${API_URL}/api/news/country/${c.id}`);
    const global = await warmFeed('global', `${API_URL}/api/news/country/${c.id}/global`);
    if (!local.err)  countryFeedOk++;
    if (!global.err) countryFeedOk++;
    const lTag = local.err  ? `ERR ${local.err}`  : `${local.ms}ms`;
    const gTag = global.err ? `ERR ${global.err}` : `${global.ms}ms`;
    console.log(`${TAG}   ${c.iso} ${(c.name || '').padEnd(20)} local=${lTag.padEnd(14)} global=${gTag}`);
  }
  console.log('');

  // Phase 2 — city feeds (local + global) for the top CITY_LIMIT
  // cities by population. Cities have NO server-side cache before the
  // companion server.js change, so before the deploy these warmings do
  // nothing. Post-deploy they fill the same per-feed in-process cache.
  let cityFeedOk = 0;
  let cityResults = [];
  if (CITY_LIMIT > 0) {
    let cities = [];
    try {
      cities = await pickTopCities(CITY_LIMIT);
    } catch (err) {
      console.warn(`${TAG} city discovery failed (${err.message}). Skipping city phase.`);
    }
    if (cities.length) {
      console.log(`${TAG} city feeds: warming local + global for top ${cities.length} cities by population…`);
      for (const c of cities) {
        const local  = await warmFeed('local',  `${API_URL}/api/news/city/${c.id}`);
        const global = await warmFeed('global', `${API_URL}/api/news/city/${c.id}/global`);
        if (!local.err)  cityFeedOk++;
        if (!global.err) cityFeedOk++;
        cityResults.push({ city: c, local, global });
        const lTag = local.err  ? `ERR ${local.err}`  : `${local.ms}ms`;
        const gTag = global.err ? `ERR ${global.err}` : `${global.ms}ms`;
        console.log(`${TAG}   ${(c.name || '').padEnd(20)} pop=${String(c.population).padStart(8)} local=${lTag.padEnd(14)} global=${gTag}`);
      }
      console.log('');
    }
  }

  const results = [];
  for (let i = 0; i < countries.length; i += CONCURRENCY) {
    const batch = countries.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(processOne));
    results.push(...out);
    for (const r of out) {
      const fmt = (k) => {
        const v = r.results[k];
        if (!v) return '—';
        return v.err ? `ERR ${v.err}` : `${v.ms}ms`;
      };
      console.log(
        `${TAG}   ${r.country.iso} ${(r.country.name || '').padEnd(20)} ` +
        `agg(about=${fmt('about/aggregate').padEnd(14)} from=${fmt('from/aggregate').padEnd(14)}) ` +
        `ind(about=${fmt('about/individual').padEnd(14)} from=${fmt('from/individual').padEnd(14)})`
      );
    }
  }

  // Aggregate stats by (direction, mode) so we can spot which combos
  // are still slow even after the prewarm flag deploys.
  const subRequests = results.flatMap(r => Object.entries(r.results)
    .map(([key, v]) => ({ key, ok: !v.err, ms: v.ms || 0 })));
  const okCount = subRequests.filter(s => s.ok).length;
  const totalMs = subRequests.reduce((s, x) => s + x.ms, 0);
  const byKey = {};
  for (const s of subRequests) {
    byKey[s.key] = byKey[s.key] || { ok: 0, total: 0 };
    byKey[s.key].total++;
    if (s.ok) byKey[s.key].ok++;
  }
  const breakdown = Object.entries(byKey)
    .map(([k, v]) => `${k}=${v.ok}/${v.total}`).join(' ');
  const countryFeedTotal = countries.length * 2;
  const cityFeedTotal    = cityResults.length * 2;
  console.log(
    `\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `core_ok=${coreOk}/1 ` +
    `country_feeds_ok=${countryFeedOk}/${countryFeedTotal} ` +
    `city_feeds_ok=${cityFeedOk}/${cityFeedTotal} ` +
    `flows_ok=${okCount}/${subRequests.length} (${breakdown}) ` +
    `total_flow_ms=${totalMs}`
  );

  // Non-zero exit only if EVERY sub-request across every phase failed
  // (API likely down). Partial failures across phases are normal.
  const totalAttempts = 1 + countryFeedTotal + cityFeedTotal + subRequests.length;
  const totalOk       = coreOk + countryFeedOk + cityFeedOk + okCount;
  if (totalAttempts > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
