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
const TIMEOUT_MS  = parseInt(process.env.PREWARM_TIMEOUT_MS  || '95000', 10);
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
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

async function warm(label, url) {
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

  // Phase 1 — country feeds (local + global) for top N
  console.log(`${TAG} phase 1: warming local + global feeds for ${countries.length} countries…`);
  let countryOk = 0;
  for (let i = 0; i < countries.length; i += CONCURRENCY) {
    const batch = countries.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(async c => {
      const [local, global] = await Promise.all([
        warm('local',  `${API_URL}/api/news/country/${c.id}`),
        warm('global', `${API_URL}/api/news/country/${c.id}/global`),
      ]);
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
          const [local, global] = await Promise.all([
            warm('local',  `${API_URL}/api/news/city/${c.id}`),
            warm('global', `${API_URL}/api/news/city/${c.id}/global`),
          ]);
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
  const totalAttempts = topOf.length + countries.length * 2 + cityCount * 2;
  const totalOk = topOk + countryOk + cityOk;
  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — top=${topOk}/${topOf.length} countries=${countryOk}/${countries.length * 2} cities=${cityOk}/${cityCount * 2}`);

  if (totalAttempts > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
