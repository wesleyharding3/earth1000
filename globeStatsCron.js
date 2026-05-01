#!/usr/bin/env node
'use strict';

// Cap DB pool before any module loads ./db. Most of this cron's work is
// external API fetches (FRED / World Bank / commodities); only a few writes
// at the end. 2 connections is more than enough.
process.env.DB_POOL_MAX = "2";

/**
 * globeStatsCron.js
 *
 * Pre-fetches globe statistics from external APIs (FRED, World Bank, Gold API)
 * and writes results to keyword_intelligence_cache for instant API serving.
 *
 * Recommended: run every 6 hours (data sources update daily at most).
 *   Schedule: 0 0,6,12,18 * * *
 *
 * Environment variables:
 *   DATABASE_URL   — PostgreSQL connection string (required)
 *   FRED_API_KEY   — FRED API key (required for commodities + economic data)
 *
 * Usage:
 *   node globeStatsCron.js
 */

require('dotenv').config();
const pool = require('./db');

const FRED_API_KEY = process.env.FRED_API_KEY || '';

function elapsed(t0) { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }
const TAG = '[globeStatsCron]';

// ────────────────────────────────────────────────────────────────────────────
//  FRED helper — pulls last N observations for a given series.
//
//  Two layers of resilience because FRED's app servers reject parallel
//  bursts with transient 5xx (NOT 429 — they're not rate-limiting us,
//  the backend is just hot):
//
//    1. Concurrency cap (FRED_MAX_CONCURRENT) — we used to fire 13+
//       requests in parallel from the commodities block. Capping in-
//       flight calls at 3 prevents the burst from saturating any one
//       FRED app server in the first place.
//
//    2. Retry with exponential backoff on 5xx (and on network errors).
//       Most 5xx retries succeed on attempt 2 because the burst pressure
//       has cleared by then. 4xx returns aren't retried — they're
//       permanent (bad series id, missing key, etc.) and retrying just
//       wastes runtime.
// ────────────────────────────────────────────────────────────────────────────
const FRED_MAX_CONCURRENT = 3;
let _fredInFlight = 0;
const _fredQueue = [];
function _fredAcquire() {
  return new Promise(resolve => {
    if (_fredInFlight < FRED_MAX_CONCURRENT) {
      _fredInFlight++;
      resolve();
    } else {
      _fredQueue.push(resolve);
    }
  });
}
function _fredRelease() {
  _fredInFlight--;
  if (_fredQueue.length) {
    _fredInFlight++;
    _fredQueue.shift()();
  }
}

async function fredLatest(seriesId, limit = 2) {
  if (!FRED_API_KEY) return null;
  await _fredAcquire();
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json`
      + `&sort_order=desc&limit=${limit}`;
    // Backoff schedule. First attempt is immediate; subsequent ones
    // wait 300ms, 1.2s, 3.5s. Max 4 attempts means worst-case ~5s
    // wasted per persistently-failing series, which is fine — the
    // cron's total runtime is already 16s and a single permanent
    // failure shouldn't compound.
    const RETRY_DELAYS_MS = [0, 300, 1200, 3500];
    let lastErrMsg = '';
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        // Network-level error (DNS, connection reset). Retry.
        lastErrMsg = e.message;
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        // Transient server error — retry.
        lastErrMsg = `FRED ${res.status}`;
        continue;
      }
      if (!res.ok) {
        // 4xx is permanent (bad series, bad key). No retry.
        console.warn(`${TAG} FRED ${seriesId} failed: FRED ${res.status}`);
        return null;
      }
      try {
        const data = await res.json();
        const obs = (data.observations || []).filter(o => o.value !== '.');
        if (!obs.length) return null;
        return parseFloat(obs[0].value);
      } catch (e) {
        // Malformed body — treat as transient and retry.
        lastErrMsg = e.message;
        continue;
      }
    }
    console.warn(`${TAG} FRED ${seriesId} failed after ${RETRY_DELAYS_MS.length} attempts: ${lastErrMsg}`);
    return null;
  } finally {
    _fredRelease();
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  World Bank helper — fetch a single indicator for given countries/years
//  Returns the latest non-null value for the first country, or a multi-series
//  object when multiple countries are requested.
// ────────────────────────────────────────────────────────────────────────────
async function wbFetch(indicator, countries = ['WLD'], dateRange = '2018:2025') {
  try {
    const countryStr = countries.join(';');
    const url = `https://api.worldbank.org/v2/country/${countryStr}/indicator/${indicator}`
      + `?date=${dateRange}&format=json&per_page=500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WB ${res.status}`);
    const json = await res.json();
    if (!json[1] || !json[1].length) return null;

    const rows = json[1];

    if (countries.length === 1 && countries[0] === 'WLD') {
      // Single global value — return latest non-null
      for (const r of rows) {
        if (r.value != null) return r.value;
      }
      return null;
    }

    // Multi-country: build a series object for the frontend
    const byCountry = {};
    for (const r of rows) {
      const name = r.country?.value || r.countryiso3code;
      if (!byCountry[name]) byCountry[name] = { name, values: [] };
      byCountry[name].values.push({ year: parseInt(r.date), value: r.value });
    }
    const series = Object.values(byCountry).map(c => {
      c.values.sort((a, b) => a.year - b.year);
      return { name: c.name, values: c.values.map(v => v.value) };
    });
    const labels = series[0]?.values?.length
      ? Object.values(byCountry)[0].values.map(v => String(v.year))
      : [];

    return { series, labels };
  } catch (e) {
    console.warn(`${TAG} World Bank ${indicator} failed: ${e.message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Gold API helper — free tier (XAU, XAG, XPT, XPD)
// ────────────────────────────────────────────────────────────────────────────
async function goldApiPrice(symbol) {
  try {
    const res = await fetch(`https://api.gold-api.com/price/${symbol}`);
    if (!res.ok) throw new Error(`gold-api ${res.status}`);
    const data = await res.json();
    return data.price ?? null;
  } catch (e) {
    console.warn(`${TAG} Gold API ${symbol} failed: ${e.message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Fetch all globe data
// ────────────────────────────────────────────────────────────────────────────
async function fetchAll() {
  const results = {};

  // ── Commodities ──────────────────────────────────────────────────────────
  console.log(`${TAG} fetching commodities...`);
  const [
    oil, natgas, coal, gold, silver, platinum, palladium,
    copper, aluminum, wheat, corn, soybeans, coffee, cocoa, cotton, lumber, rubber
  ] = await Promise.allSettled([
    fredLatest('DCOILWTICO'),              // WTI Crude Oil
    fredLatest('DHHNGSP'),                 // Henry Hub Natural Gas
    fredLatest('PCOALAUUSDM'),             // Coal (may 400 — not all series available)
    goldApiPrice('XAU'),                   // Gold
    goldApiPrice('XAG'),                   // Silver
    goldApiPrice('XPT'),                   // Platinum
    goldApiPrice('XPD'),                   // Palladium
    fredLatest('PCOPPUSDM'),               // Copper
    fredLatest('PALUMUSDM'),               // Aluminum
    fredLatest('PWHEAMTUSDM'),             // Wheat
    fredLatest('PMAIZMTUSDM'),             // Corn (maize)
    fredLatest('PSOYBUSDM'),               // Soybeans
    fredLatest('PCOFFOTMUSDM'),            // Coffee
    fredLatest('PCOCOUSDM'),              // Cocoa
    fredLatest('PCOTTINDUSDM'),           // Cotton
    fredLatest('WPU081'),                  // Lumber (PPI index)
    fredLatest('PRUBBUSDM'),               // Rubber
  ]);

  const assign = (key, settled) => {
    if (settled.status === 'fulfilled' && settled.value != null) {
      results[key] = settled.value;
    }
  };

  assign('oil', oil);
  assign('natgas', natgas);
  assign('coal', coal);
  assign('gold', gold);
  assign('silver', silver);
  assign('platinum', platinum);
  assign('palladium', palladium);
  assign('copper', copper);
  assign('aluminum', aluminum);
  assign('wheat', wheat);
  assign('corn', corn);
  assign('soybeans', soybeans);
  assign('coffee', coffee);
  assign('cocoa', cocoa);
  assign('cotton', cotton);
  assign('lumber', lumber);
  assign('rubber', rubber);

  const commoditiesLoaded = Object.keys(results).length;
  console.log(`${TAG} commodities: ${commoditiesLoaded} loaded`);

  // ── Economic Indicators ──────────────────────────────────────────────────
  console.log(`${TAG} fetching economic indicators...`);
  const topEconomies = ['USA', 'CHN', 'JPN', 'DEU', 'IND', 'GBR'];
  const [
    gdp, gdpGrowth, inflation, unemployment, interest, debtGdp,
    tradeBalance, stockMarket, currency
  ] = await Promise.allSettled([
    wbFetch('NY.GDP.MKTP.CD', topEconomies),                   // GDP
    wbFetch('NY.GDP.MKTP.KD.ZG', ['WLD']),                     // GDP Growth %
    wbFetch('FP.CPI.TOTL.ZG', ['WLD']),                        // Inflation
    wbFetch('SL.UEM.TOTL.ZS', ['WLD']),                        // Unemployment
    fredLatest('DFF'),                                           // Fed Funds Effective Rate
    fredLatest('GFDEGDQ188S', 5),                               // US Debt-to-GDP
    wbFetch('NE.RSB.GNFS.CD', topEconomies),                   // Trade Balance
    fredLatest('NASDAQCOM'),                                    // NASDAQ Composite
    fredLatest('DTWEXBGS'),                                     // USD Trade-Weighted Index
  ]);

  assign('gdp', gdp);
  assign('gdp_growth', gdpGrowth);
  assign('inflation', inflation);
  assign('unemployment', unemployment);
  assign('interest', interest);
  assign('debt_gdp', debtGdp);
  assign('trade_balance', tradeBalance);
  assign('stock_market', stockMarket);
  assign('currency', currency);

  console.log(`${TAG} economic: ${Object.keys(results).length - commoditiesLoaded} loaded`);
  const afterEcon = Object.keys(results).length;

  // ── Demographics ─────────────────────────────────────────────────────────
  console.log(`${TAG} fetching demographics...`);
  const [population, popGrowth, medianAge, lifeExpect, migration, internet] =
    await Promise.allSettled([
      wbFetch('SP.POP.TOTL', ['WLD']),                         // World Population
      wbFetch('SP.POP.GROW', ['WLD']),                         // Population Growth
      wbFetch('SP.POP.DPND.YG', ['WLD']),                     // Youth dependency (proxy for median age)
      wbFetch('SP.DYN.LE00.IN', ['WLD']),                     // Life Expectancy
      wbFetch('SM.POP.NETM', ['USA', 'DEU', 'TUR', 'RUS', 'GBR', 'CAN']),  // Migration
      wbFetch('IT.NET.USER.ZS', ['WLD']),                     // Internet Penetration
    ]);

  assign('population', population);
  assign('pop_growth', popGrowth);
  assign('median_age', medianAge);
  assign('life_expect', lifeExpect);
  assign('migration', migration);
  assign('internet', internet);

  console.log(`${TAG} demographics: ${Object.keys(results).length - afterEcon} loaded`);
  const afterDemo = Object.keys(results).length;

  // ── Energy & Environment ─────────────────────────────────────────────────
  console.log(`${TAG} fetching energy & environment...`);
  const [co2Capita, renewable, co2Total] = await Promise.allSettled([
    wbFetch('EN.ATM.CO2E.PC', ['WLD']),                       // CO2 per capita
    wbFetch('EG.FEC.RNEW.ZS', ['WLD']),                       // Renewable %
    wbFetch('EN.ATM.CO2E.KT', ['USA', 'CHN', 'IND', 'RUS', 'JPN', 'DEU']),  // CO2 emissions
  ]);

  assign('co2_capita', co2Capita);
  assign('renewable', renewable);
  assign('co2', co2Total);

  console.log(`${TAG} energy: ${Object.keys(results).length - afterDemo} loaded`);
  const afterEnergy = Object.keys(results).length;

  // ── Geopolitical ─────────────────────────────────────────────────────────
  console.log(`${TAG} fetching geopolitical...`);
  const [military] = await Promise.allSettled([
    wbFetch('MS.MIL.XPND.CD', ['USA', 'CHN', 'RUS', 'IND', 'SAU', 'GBR']),  // Military spending
  ]);

  assign('military', military);

  console.log(`${TAG} geopolitical: ${Object.keys(results).length - afterEnergy} loaded`);

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
//  DB resilience — Render's shared Postgres has a hard ceiling on
//  connections. When other services (main app, other crons) are
//  collectively at the limit, our pool.acquire() returns "too many
//  clients already" or "remaining connection slots are reserved for
//  roles with the SUPERUSER attribute". Both surface as PG error
//  53300 (too_many_connections). Retrying with backoff usually wins —
//  some other service finishes its query and frees a slot within a
//  few seconds.
//
//  Network-level errors (ECONNREFUSED, ETIMEDOUT, "Connection terminated")
//  also retry: those are typically transient too on managed PG.
//  Anything else (syntax error, FK violation, etc.) is permanent and
//  rethrows immediately so we don't burn time retrying real bugs.
// ────────────────────────────────────────────────────────────────────────────
function isDbConnectionError(err) {
  if (!err) return false;
  if (err.code === '53300') return true;        // PG: too_many_connections
  if (err.code === '53400') return true;        // PG: configuration_limit_exceeded
  if (err.code === 'ECONNREFUSED') return true;
  if (err.code === 'ETIMEDOUT') return true;
  const msg = String(err.message || '').toLowerCase();
  return /too many clients|connection slots are reserved|connection terminated|connection ended|econnrefused|etimedout/i.test(msg);
}

async function withDbRetry(fn, label) {
  const RETRY_DELAYS_MS = [0, 1000, 3000, 8000];
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isDbConnectionError(e)) throw e;
      console.warn(`${TAG} ${label} db saturation, retry ${attempt + 1}/${RETRY_DELAYS_MS.length}: ${e.message}`);
    }
  }
  throw lastErr;
}

// ────────────────────────────────────────────────────────────────────────────
//  Last-known-good loader — reads the most recent cached results so we
//  can fill missing keys when a particular series 5xx'd persistently
//  this run. Daily commodity prices change <2% in a 6-hour window;
//  serving a slightly stale value beats a blank tile on the dashboard.
//  When FRED has a longer outage, this also keeps the panel populated
//  (just with values that visibly stop advancing) until they recover.
// ────────────────────────────────────────────────────────────────────────────
async function loadPrevCache(mode, filterKey) {
  try {
    const rows = await withDbRetry(async () => {
      const r = await pool.query(`
        SELECT results
          FROM keyword_intelligence_cache
         WHERE mode = $1 AND filter_key = $2
         ORDER BY computed_at DESC
         LIMIT 1
      `, [mode, filterKey]);
      return r.rows;
    }, 'loadPrevCache');
    if (!rows.length) return null;
    const r = rows[0].results;
    return typeof r === 'string' ? JSON.parse(r) : r;
  } catch (e) {
    console.warn(`${TAG} loadPrevCache failed: ${e.message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  DB cache writer (same table as sourcesStatsCron). Both queries go
//  through withDbRetry so a single saturated moment doesn't fail the
//  whole run. The prune is best-effort — if it fails after the insert
//  succeeded, the row count just runs slightly above the 6-row cap
//  until the next prune; not worth aborting over.
// ────────────────────────────────────────────────────────────────────────────
async function writeCache(mode, filterKey, results) {
  await withDbRetry(async () => {
    await pool.query(`
      INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
      VALUES ($1, $2, $3)
    `, [mode, filterKey, JSON.stringify(results)]);
  }, 'writeCache insert');

  // Prune: keep the 6 most recent rows per mode+filter
  try {
    await withDbRetry(async () => {
      await pool.query(`
        DELETE FROM keyword_intelligence_cache
        WHERE mode = $1 AND filter_key = $2
          AND id NOT IN (
            SELECT id FROM keyword_intelligence_cache
            WHERE mode = $1 AND filter_key = $2
            ORDER BY computed_at DESC
            LIMIT 6
          )
      `, [mode, filterKey]);
    }, 'writeCache prune');
  } catch (e) {
    console.warn(`${TAG} prune failed (insert already succeeded): ${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Main
// ────────────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log(`${TAG} ${new Date().toISOString()} — starting`);

  if (!FRED_API_KEY) {
    console.warn(`${TAG} WARNING: FRED_API_KEY not set — commodity/economic data will be empty`);
  }

  try {
    const results = await fetchAll();
    const fetchedCount = Object.keys(results).length;
    console.log(`${TAG} total indicators fetched: ${fetchedCount} (${elapsed(t0)})`);

    // Fill any holes from the previous cache row before we write —
    // when a single FRED series 5xxs through all retries, this
    // preserves its last-known-good value instead of letting the new
    // row drop the key entirely (which would render as "—" on the
    // dashboard tile). New successful fetches always win; we only
    // copy keys that are missing from THIS run's results.
    const prev = await loadPrevCache('globe-stats', 'global');
    let reused = 0;
    if (prev && typeof prev === 'object') {
      for (const k of Object.keys(prev)) {
        if (results[k] == null && prev[k] != null) {
          results[k] = prev[k];
          reused++;
        }
      }
    }
    if (reused) {
      console.log(`${TAG} reused ${reused} stale value(s) from prev cache`);
    }

    const count = Object.keys(results).length;
    if (count > 0) {
      try {
        await writeCache('globe-stats', 'global', results);
        console.log(`${TAG} cached to DB (${elapsed(t0)})`);
      } catch (e) {
        // Already retried inside withDbRetry. If we still can't write,
        // the DB is genuinely down or saturated for the entire backoff
        // window. Log loudly but don't exit non-zero — the data we
        // fetched is good, the next run (6h later) will get a fresh
        // shot at writing, and Render's "cron failed" alert is reserved
        // for actual code errors. Stale tiles from the previous cache
        // row still serve users in the meantime.
        console.warn(`${TAG} writeCache failed after retries: ${e.message}`);
        console.warn(`${TAG} skipping write — next run will retry; dashboard continues serving prev cache`);
      }
    } else {
      console.warn(`${TAG} no data fetched — skipping cache write`);
    }

    console.log(`${TAG} done in ${elapsed(t0)}`);
  } catch (err) {
    console.error(`${TAG} fatal:`, err.message);
    process.exit(1);
  } finally {
    // pool.end() can itself throw if every slot was previously
    // unreachable — swallow so the process exits cleanly.
    try { await pool.end(); } catch (_) {}
  }
}

run();
