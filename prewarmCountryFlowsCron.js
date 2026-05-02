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
const TOP_N       = Math.max(1, parseInt(process.env.PREWARM_COUNTRY_LIMIT || '50', 10));

const TAG = '[prewarm-countries]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

// Top-50 ISO codes by typical news mention volume, hand-curated for
// stability. Tunable per-run via PREWARM_COUNTRY_ISOS env var. If you
// later want this to be DB-driven (top by recent article_locations),
// the right place is a server-side endpoint /api/countries/top-mentioned
// that the cron can hit; doing it client-side here would force the cron
// to open a PG pool which we just removed.
const DEFAULT_TOP_ISOS = [
  'US','GB','RU','CN','IR','IL','UA','IN','DE','FR',
  'BR','JP','IT','ES','MX','CA','AU','KR','TR','NG',
  'ZA','EG','SA','PK','ID','AR','PL','NL','SE','CH',
  'AE','QA','KW','SY','LB','IQ','AF','YE','JO','OM',
  'GR','KE','ET','MA','VE','CO','PE','TH','VN','PH',
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
  const data = await fetchJSON(`${API_URL}/api/countries/all`);
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
  if (process.env.PREWARM_COUNTRY_ISOS) {
    return process.env.PREWARM_COUNTRY_ISOS
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return DEFAULT_TOP_ISOS.slice(0, TOP_N);
}

async function warmFlow(direction, country) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    mode:        'aggregate',
    view_mode:   'country',
    limit:       '500',
    from_date:   isoDate(weekAgo),
    to_date:     isoDate(today),
    [direction === 'about' ? 'about_country' : 'from_country']: String(country.id),
  });
  const url = `${API_URL}/api/flows?${params.toString()}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    return { direction, country, ms: Date.now() - t0, err: e.message };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { direction, country, ms, err: `HTTP ${res.status}` };
  await res.text().catch(() => {});
  return { direction, country, ms };
}

async function processOne(country) {
  // about + from in parallel — different routes, no pool conflict between
  // them (the server runs each in its own pg connection with its own
  // statement_timeout). Within-country parallelism is fine.
  const [aboutR, fromR] = await Promise.allSettled([
    warmFlow('about', country),
    warmFlow('from',  country),
  ]);
  return {
    country,
    about: aboutR.status === 'fulfilled' ? aboutR.value : { err: aboutR.reason?.message || 'unknown', ms: 0 },
    from:  fromR.status  === 'fulfilled' ? fromR.value  : { err: fromR.reason?.message  || 'unknown', ms: 0 },
  };
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

  const results = [];
  for (let i = 0; i < countries.length; i += CONCURRENCY) {
    const batch = countries.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(processOne));
    results.push(...out);
    for (const r of out) {
      const aboutTag = r.about.err ? `ERR ${r.about.err}` : `${r.about.ms}ms`;
      const fromTag  = r.from.err  ? `ERR ${r.from.err}`  : `${r.from.ms}ms`;
      console.log(`${TAG}   ${r.country.iso} ${(r.country.name || '').padEnd(20)} about=${aboutTag.padEnd(14)} from=${fromTag}`);
    }
  }

  const aboutOk = results.filter(r => !r.about.err).length;
  const fromOk  = results.filter(r => !r.from.err).length;
  const totalMs = results.reduce((s, r) => s + (r.about.ms || 0) + (r.from.ms || 0), 0);
  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — about_ok=${aboutOk}/${results.length} from_ok=${fromOk}/${results.length} total_query_ms=${totalMs}`);

  // Non-zero exit only if EVERY query failed (API likely down).
  const totalOk = aboutOk + fromOk;
  const totalCount = results.length * 2;
  if (totalCount > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
