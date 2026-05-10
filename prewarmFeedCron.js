#!/usr/bin/env node
'use strict';

/**
 * prewarmFeedCron.js
 *
 * Owns ALL feed surface warming — the raw-article reading experience:
 *   • /api/articles/recent          (the live ticker)
 *   • /api/news/search              (the default news feed)
 *   • /api/news/country/:id         (per-country local feed) + /global
 *   • /api/news/city/:id            (per-city local feed) + /global
 *
 * Why a dedicated cron: the article fetcher runs hourly, so feed data
 * only changes once an hour. A 1h cadence cron sized to match keeps
 * every feed surface warm for any user landing on the app.
 *
 * Pure HTTP — no DB connection. Discovers top countries/cities via the
 * cached /api/countries and /api/cities endpoints (24h TTL each, so the
 * lookup is essentially free).
 *
 * Env vars:
 *   API_URL                   base URL of the API (default: http://localhost:3000)
 *   PREWARM_COUNTRY_LIMIT     override top-N countries (default: 100)
 *   PREWARM_CITY_LIMIT        override top-N cities (default: 50)
 *   PREWARM_TIMEOUT_MS        per-request timeout (default: 95000)
 *   PREWARM_CONCURRENCY       parallel requests (default: 1)
 *
 * Run:
 *   node prewarmFeedCron.js
 *
 * Wire to hourly Render Cron:
 *   `15 * * * *` (15 past every hour)
 */

require('dotenv').config({ override: true });

const API_URL     = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
// 130s — must outlive the server's prewarm SQL ceiling (120s on
// /api/news/country/:id and /:id/global). Earlier 95s default capped
// the cron BELOW the server's 90s SQL limit + buffer; bumped in
// lockstep with the server's 90s→120s bump so a long-running cold-
// buffer query for IL/UA/IN/BR/MX gets to actually finish instead of
// being killed mid-flight by the cron's fetch timeout.
const TIMEOUT_MS  = parseInt(process.env.PREWARM_TIMEOUT_MS  || '130000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));
const COUNTRY_LIMIT = Math.max(0, parseInt(process.env.PREWARM_COUNTRY_LIMIT || '100', 10));
const CITY_LIMIT    = Math.max(0, parseInt(process.env.PREWARM_CITY_LIMIT    || '50', 10));

const TAG = '[prewarm-feed]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

// Top-100 ISO list — same hand-curated set used by prewarm-countries.
// Override with PREWARM_FEED_ISOS env var if you want different countries.
const DEFAULT_TOP_ISOS = [
  'US','GB','RU','CN','IR','IL','UA','IN','DE','FR',
  'BR','JP','IT','ES','MX','CA','AU','KR','TR','NG',
  'ZA','EG','SA','PK','ID','AR','PL','NL','SE','CH',
  'AE','QA','KW','SY','LB','IQ','AF','YE','JO','OM',
  'GR','KE','ET','MA','VE','CO','PE','TH','VN','PH',
  'PT','IE','BE','AT','NO','DK','FI','CZ','RO','HU',
  'RS','HR','BG','SK','LT','LV','EE','IS',
  'HK','TW','BD','MM','LK','NP','KZ','MY','NZ',
  'BH','DZ','TN','LY','SD','GH','SN','UG','TZ','ZW',
  'AO','MZ',
  'CL','EC','BO','GT','HN','CR','PA','DO','JM','CU','HT',
];

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function fetchJSON(url) {
  // Single retry on 5xx + a 3s backoff. Mirrors the warm() helper —
  // cold-start DB connections to /api/countries and /api/tags can
  // exceed the 45s statement_timeout on the first hit (no in-process
  // ttlCache, pool just warmed). The first attempt loads the rows
  // into Postgres' buffer cache; the retry typically completes fast.
  // Without this, a single 500 on /api/countries fataled the cron.
  const _attempt = async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  try {
    return await _attempt();
  } catch (err) {
    if (err.status >= 500 && err.status < 600) {
      console.warn(`${TAG} fetchJSON ${url} returned ${err.status}; retrying in 3s…`);
      await new Promise(r => setTimeout(r, 3000));
      return await _attempt();
    }
    throw err;
  }
}

async function resolveIsoMap() {
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

function pickIsos() {
  if (process.env.PREWARM_FEED_ISOS) {
    return process.env.PREWARM_FEED_ISOS
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return DEFAULT_TOP_ISOS.slice(0, COUNTRY_LIMIT);
}

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

async function fetchAllTags() {
  const data = await fetchJSON(`${API_URL}/api/tags`);
  const arr = Array.isArray(data) ? data : (data?.tags || data?.data || []);
  return arr.filter(t => t && t.id).map(t => ({ id: t.id, name: t.name || `tag:${t.id}` }));
}

async function warm(label, url) {
  // Single retry on 5xx. The first attempt — even when it times out at
  // the SQL ceiling — pulls the relevant article_locations / news_articles
  // pages into Postgres' buffer cache. The second attempt typically
  // completes in 30-50% of the first attempt's time because those pages
  // are already in RAM. Without this, top-mention countries that need
  // ~120s on a stone-cold buffer never recover within a single cron
  // run. Network failures (no status) and 4xx (auth, malformed) skip
  // retry — they won't change in 3 seconds.
  const _attempt = async () => {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(url);
      const ms = Date.now() - t0;
      // Cancel body stream — the server's ttlCached() populates the cache
      // INSIDE the callback before res.json() runs, so by the time we get
      // headers the cache is warm. Reading the body just buffers MBs of
      // JSON we don't need (US global feed alone OOMs Render's 512MB cap).
      try { await r.body?.cancel?.(); } catch {}
      return { ms, err: r.ok ? null : `HTTP ${r.status}`, status: r.status };
    } catch (e) {
      return { ms: Date.now() - t0, err: e.message, status: null };
    }
  };

  let r = await _attempt();
  if (r.err && r.status >= 500 && r.status < 600) {
    await new Promise(rs => setTimeout(rs, 3000));
    const r2 = await _attempt();
    if (!r2.err) return { label, ms: r.ms + 3000 + r2.ms, retried: true };
    return { label, ms: r.ms + 3000 + r2.ms, err: r2.err, retried: true };
  }
  if (r.err) return { label, ms: r.ms, err: r.err };
  return { label, ms: r.ms };
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} countries=${COUNTRY_LIMIT} cities=${CITY_LIMIT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  // Phase 0 — top-of-app feeds (no IDs needed)
  console.log(`${TAG} phase 0: warming top-of-app feeds…`);
  const topOf = await Promise.all([
    warm('articles/recent', `${API_URL}/api/articles/recent`),
    warm('news/search',     `${API_URL}/api/news/search`),
  ]);
  for (const r of topOf) {
    const tag = r.err ? `ERR ${r.err}` : `${r.ms}ms`;
    console.log(`${TAG}   /api/${r.label.padEnd(20)} [${tag}]`);
  }
  console.log('');

  // Phase 0.5 — category-filtered news/search.
  // Frontend Feed tab fetches `/api/news/search?tag=X&limit=25&offset=N`
  // (LIMIT=25 in www/index.html). Without warming, the first user to pick
  // any category pays the full cold-cache cost (up to the 30s
  // statement_timeout in server.js:2562). Warm the first two pages for
  // every tag so the "Topics" dropdown is always instant.
  let tags = [];
  try { tags = await fetchAllTags(); }
  catch (err) { console.warn(`${TAG} /api/tags fetch failed (${err.message}); skipping tag phase.`); }
  let tagOk = 0;
  if (tags.length) {
    const TAG_PAGES = ['&offset=0', '&offset=25'];
    console.log(`${TAG} phase 0.5: warming category-filtered feeds for ${tags.length} tags…`);
    for (let i = 0; i < tags.length; i += CONCURRENCY) {
      const batch = tags.slice(i, i + CONCURRENCY);
      const out = await Promise.all(batch.map(async t => {
        const tasks = TAG_PAGES.map(off =>
          warm('tag', `${API_URL}/api/news/search?tag=${t.id}&limit=25${off}`)
        );
        const results = await Promise.all(tasks);
        // Worst result (slowest / errored) summarizes the row
        const worst = results.reduce((a, r) => (r.err || (r.ms > (a.ms || 0))) ? r : a, results[0]);
        return { t, worst, allOk: results.every(r => !r.err), results };
      }));
      for (const r of out) {
        if (r.allOk) tagOk++;
        const status = r.worst.err ? `ERR ${r.worst.err}` : `${r.worst.ms}ms`;
        console.log(`${TAG}   tag=${String(r.t.id).padStart(4)} ${(r.t.name || '').padEnd(20)} [${status}]`);
      }
    }
  }
  console.log('');

  // Resolve top-N countries
  let isoMap;
  try {
    isoMap = await resolveIsoMap();
  } catch (err) {
    console.error(`${TAG} fatal: /api/countries fetch failed (${err.message}). Verify API_URL is reachable.`);
    process.exit(1);
  }
  const requestedIsos = pickIsos();
  const countries = requestedIsos
    .map(iso => {
      const m = isoMap.get(iso);
      return m ? { iso, id: m.id, name: m.name } : null;
    })
    .filter(Boolean);

  // Phase 1 — country feeds (local + global) for top N.
  // The front-end paginates at limit=60 (see index.html ~19289), and the
  // cache is keyed by (limit, offset) — so we MUST warm the exact shape
  // the user requests. Two pages × two surfaces = first 120 articles per
  // country are guaranteed cache hits during infinite scroll.
  const FEED_PAGES = ['?limit=60&offset=0', '?limit=60&offset=60'];
  console.log(`${TAG} phase 1: warming local + global feeds for ${countries.length} countries…`);
  let countryOk = 0;
  for (let i = 0; i < countries.length; i += CONCURRENCY) {
    const batch = countries.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(async c => {
      // Warm both pages for both surfaces (4 requests per country).
      // The /global URLs get &prewarm=1 so the server grants a 90s
      // statement_timeout (vs the 45s pool default) — high-volume
      // countries (US, GB, RU, CN, IR, IL, UA, IN, DE) were tripping
      // the 45s on the article_locations × news_articles cross-join
      // and returning HTTP 500 here. The local feed isn't failing so
      // it stays on the default budget.
      const tasks = [];
      for (const qs of FEED_PAGES) {
        tasks.push(warm('local',  `${API_URL}/api/news/country/${c.id}${qs}`));
        tasks.push(warm('global', `${API_URL}/api/news/country/${c.id}/global${qs}&prewarm=1`));
      }
      const results = await Promise.all(tasks);
      // Flatten into local/global summary so the existing log format still
      // works — report the worst (slowest / errored) per surface.
      const local  = results.filter(r => r.label === 'local').reduce((a, r) => a.err || (r.ms > (a.ms || 0)) ? r : a, results[0]);
      const global = results.filter(r => r.label === 'global').reduce((a, r) => a.err || (r.ms > (a.ms || 0)) ? r : a, results[1]);
      return { c, local, global };
    }));
    for (const r of out) {
      if (!r.local.err)  countryOk++;
      if (!r.global.err) countryOk++;
      const lTag = r.local.err  ? `ERR ${r.local.err}`  : `${r.local.ms}ms`;
      const gTag = r.global.err ? `ERR ${r.global.err}` : `${r.global.ms}ms`;
      console.log(`${TAG}   ${r.c.iso} ${(r.c.name || '').padEnd(20)} local=${lTag.padEnd(14)} global=${gTag}`);
    }
  }
  console.log('');

  // Phase 2 — city feeds (local + global) for top N
  let cityOk = 0;
  let cityCount = 0;
  if (CITY_LIMIT > 0) {
    let cities = [];
    try { cities = await pickTopCities(CITY_LIMIT); }
    catch (err) { console.warn(`${TAG} city discovery failed (${err.message}); skipping city phase.`); }
    cityCount = cities.length;
    if (cities.length) {
      console.log(`${TAG} phase 2: warming local + global feeds for top ${cities.length} cities…`);
      for (let i = 0; i < cities.length; i += CONCURRENCY) {
        const batch = cities.slice(i, i + CONCURRENCY);
        const out = await Promise.all(batch.map(async c => {
          // Cities mirror the country pattern — global gets &prewarm=1
          // for the 90s budget, local stays on the default. See country
          // phase above for full rationale.
          const tasks = [];
          for (const qs of FEED_PAGES) {
            tasks.push(warm('local',  `${API_URL}/api/news/city/${c.id}${qs}`));
            tasks.push(warm('global', `${API_URL}/api/news/city/${c.id}/global${qs}&prewarm=1`));
          }
          const results = await Promise.all(tasks);
          const local  = results.filter(r => r.label === 'local').reduce((a, r) => a.err || (r.ms > (a.ms || 0)) ? r : a, results[0]);
          const global = results.filter(r => r.label === 'global').reduce((a, r) => a.err || (r.ms > (a.ms || 0)) ? r : a, results[1]);
          return { c, local, global };
        }));
        for (const r of out) {
          if (!r.local.err)  cityOk++;
          if (!r.global.err) cityOk++;
          const lTag = r.local.err  ? `ERR ${r.local.err}`  : `${r.local.ms}ms`;
          const gTag = r.global.err ? `ERR ${r.global.err}` : `${r.global.ms}ms`;
          console.log(`${TAG}   ${(r.c.name || '').padEnd(20)} pop=${String(r.c.population).padStart(8)} local=${lTag.padEnd(14)} global=${gTag}`);
        }
      }
    }
  }

  const topOk = topOf.filter(r => !r.err).length;
  const totalAttempts = topOf.length + tags.length + countries.length * 2 + cityCount * 2;
  const totalOk = topOk + tagOk + countryOk + cityOk;
  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — top=${topOk}/${topOf.length} tags=${tagOk}/${tags.length} countries=${countryOk}/${countries.length * 2} cities=${cityOk}/${cityCount * 2}`);

  if (totalAttempts > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
