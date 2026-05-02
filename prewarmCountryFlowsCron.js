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
 * Companion to prewarmKeywordCacheCron.js, which covers keyword-filtered
 * queries. This one covers country-filtered queries — the OTHER major
 * cold-cache axis on the flows endpoint.
 *
 * Country selection: dynamically picks the 50 ISOs most-mentioned in
 * article_locations over the last 30 days. Stable enough day-to-day to
 * give consistent cache coverage; reactive enough that emerging stories
 * (Sudan, Niger, etc.) make it onto the warm list as their coverage grows.
 *
 * Cadence: daily is fine if you also bump the flows cache TTL to >24h
 * for these queries. With the current 600s TTL, a daily run only keeps
 * the cache warm for the first 10 min of each day — so either run more
 * often (every ~10 min) or bump the TTL. The cron itself doesn't enforce
 * either; that's a deployment-side choice.
 *
 * Env vars:
 *   API_URL                    base URL of the API (default: http://localhost:3000)
 *   PREWARM_COUNTRY_LIMIT      override top-N count (default: 50)
 *   PREWARM_TIMEOUT_MS         per-request timeout (default: 60000)
 *   PREWARM_CONCURRENCY        parallel requests (default: 1, serialize)
 *
 * Run:
 *   node prewarmCountryFlowsCron.js                 # warms top 50 about + from
 *   PREWARM_COUNTRY_LIMIT=20 node prewarmCountryFlowsCron.js  # smaller pass
 *
 * Wire to a daily Render Cron / system cron:
 *   `15 4 * * * cd /app && node prewarmCountryFlowsCron.js`
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');

const API_URL     = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS  = parseInt(process.env.PREWARM_TIMEOUT_MS  || '60000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));
const TOP_N       = Math.max(1, parseInt(process.env.PREWARM_COUNTRY_LIMIT || '50', 10));

const TAG = '[prewarm-countries]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Pull the top-N countries (by id, with iso) ranked by recent article_locations
// mentions. 30-day window keeps the list responsive to emerging stories
// without thrashing day-to-day.
async function pickTopCountries(n) {
  const { rows } = await pool.query(`
    SELECT c.id, c.iso_code AS iso, c.name, COUNT(DISTINCT al.article_id)::int AS mentions
      FROM article_locations al
      JOIN countries c ON c.id = al.country_id
      JOIN news_articles a ON a.id = al.article_id
     WHERE a.published_at > NOW() - INTERVAL '30 days'
       AND c.iso_code IS NOT NULL AND length(c.iso_code) = 2
     GROUP BY c.id, c.iso_code, c.name
     ORDER BY mentions DESC
     LIMIT $1
  `, [n]);
  return rows;
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
  // Drain so the connection closes cleanly.
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

  const countries = await pickTopCountries(TOP_N);
  if (!countries.length) {
    console.log(`${TAG} no countries found — exiting`);
    await pool.end();
    return;
  }
  console.log(`${TAG} top ${countries.length} countries: ${countries.map(c => c.iso).join(',')}`);

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

  // Non-zero exit only if EVERY query failed (API likely down). Per-country
  // failures are fine; cron monitoring should care about catastrophic only.
  if (aboutOk === 0 && fromOk === 0) process.exit(1);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
