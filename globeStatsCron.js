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
//  FRED helper — pulls last N observations for a given series
// ────────────────────────────────────────────────────────────────────────────
async function fredLatest(seriesId, limit = 2) {
  if (!FRED_API_KEY) return null;
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json`
      + `&sort_order=desc&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED ${res.status}`);
    const data = await res.json();
    const obs = (data.observations || []).filter(o => o.value !== '.');
    if (!obs.length) return null;
    return parseFloat(obs[0].value);
  } catch (e) {
    console.warn(`${TAG} FRED ${seriesId} failed: ${e.message}`);
    return null;
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
//  DB cache writer (same table as sourcesStatsCron)
// ────────────────────────────────────────────────────────────────────────────
async function writeCache(mode, filterKey, results) {
  await pool.query(`
    INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
    VALUES ($1, $2, $3)
  `, [mode, filterKey, JSON.stringify(results)]);

  // Prune: keep the 6 most recent rows per mode+filter
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
    const count = Object.keys(results).length;
    console.log(`${TAG} total indicators fetched: ${count} (${elapsed(t0)})`);

    if (count > 0) {
      await writeCache('globe-stats', 'global', results);
      console.log(`${TAG} cached to DB (${elapsed(t0)})`);
    } else {
      console.warn(`${TAG} no data fetched — skipping cache write`);
    }

    console.log(`${TAG} done in ${elapsed(t0)}`);
  } catch (err) {
    console.error(`${TAG} fatal:`, err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
