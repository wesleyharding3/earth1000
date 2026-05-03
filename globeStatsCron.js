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
 * Production schedule: once daily (data sources update daily at most;
 * the API layer caches the result in-process for 22h to match).
 *   Schedule: 0 0 * * *
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
  // Steel: WPU101 = PPI for "Iron and steel". Index value, not $/ton —
  // the frontend tile labels it "Steel — index" instead of "$/ton" once
  // the unit override below is in effect.
  // Lithium / Cobalt / Rare Earths intentionally NOT fetched: there is
  // no reliable free real-time API for them. Trading Economics and the
  // London Metal Exchange require paid subscriptions; the World Bank
  // Pink Sheet only covers some of them at monthly cadence with a
  // 6-week lag. Their tiles were removed from the frontend rather
  // than rendering blank forever.
  console.log(`${TAG} fetching commodities...`);
  const [
    oil, natgas, coal, gold, silver, platinum, palladium,
    copper, aluminum, steel, wheat, corn, soybeans, coffee, cocoa, cotton, lumber, rubber
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
    fredLatest('WPU101'),                  // Steel (PPI index for iron & steel)
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
  assign('steel', steel);
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
  // Country basket for the per-source electricity-mix indicators below.
  // Top-10 emitters + energy producers, weighted to give the dashboard
  // a useful spread (USA + CHN dominate; the others provide texture).
  const ENERGY_BASKET = ['USA', 'CHN', 'IND', 'RUS', 'JPN', 'DEU', 'BRA', 'FRA', 'GBR', 'KOR'];

  const [co2Capita, renewable, co2Total,
         energyCoal, energyGas, energyNuclear, energyHydro] = await Promise.allSettled([
    // World Bank archived the legacy EN.ATM.CO2E.* indicators in their
    // 2026 reorg. Their replacements use AR5 methodology and live under
    // EN.GHG.CO2.*.CE.AR5. The legacy indicators returned a 175 "deleted
    // or archived" error which wbFetch's catch silently nulled, leaving
    // co2 + co2_capita widgets perpetually empty after the migration.
    // The new IDs ship Mt CO2e instead of kT CO2 (1 Mt = 1,000 kT) and
    // t CO2e/capita instead of t CO2/capita — same units the existing
    // tile labels expect.
    wbFetch('EN.GHG.CO2.PC.CE.AR5', ['WLD']),                 // CO2 per capita (global)
    wbFetch('EG.FEC.RNEW.ZS', ['WLD']),                       // Renewable %
    wbFetch('EN.GHG.CO2.MT.CE.AR5', ENERGY_BASKET),           // CO2 emissions by country
    // Electricity mix breakdowns. World Bank surfaces these as
    // % of total electricity production. Same multi-country basket
    // so the breakdowns line up with the CO2 series visually.
    wbFetch('EG.ELC.COAL.ZS', ENERGY_BASKET),                 // Coal share
    wbFetch('EG.ELC.NGAS.ZS', ENERGY_BASKET),                 // Natural gas share
    wbFetch('EG.ELC.NUCL.ZS', ENERGY_BASKET),                 // Nuclear share
    wbFetch('EG.ELC.HYRO.ZS', ENERGY_BASKET),                 // Hydro share
  ]);

  assign('co2_capita',       co2Capita);
  assign('renewable',        renewable);
  assign('co2',              co2Total);
  assign('energy_coal',      energyCoal);
  assign('energy_gas',       energyGas);
  assign('energy_nuclear',   energyNuclear);
  assign('energy_hydro',     energyHydro);

  // Wind and solar — curated. World Bank's published indicators bundle
  // wind / solar / geothermal / biomass into a single "renewables excl.
  // hydro" series (EG.ELC.RNWX.ZS), so there's no clean WB path to
  // wind-only or solar-only percentages. The most current authoritative
  // breakdown is Ember Climate's annual electricity dataset (2024
  // figures used below; refresh when their 2025 report drops, typically
  // March/April). Series shape mirrors wbFetch's multi-country output
  // so the existing frontend renderer treats them identically.
  results.energy_wind = {
    series: [
      { name: 'World',         values: [8.1] },
      { name: 'Germany',       values: [25.0] },
      { name: 'United Kingdom',values: [29.5] },
      { name: 'Spain',         values: [22.5] },
      { name: 'Brazil',        values: [13.5] },
      { name: 'United States', values: [10.2] },
      { name: 'China',         values: [9.4]  },
      { name: 'India',         values: [5.1]  },
      { name: 'France',        values: [9.7]  },
      { name: 'Japan',         values: [1.2]  },
      { name: 'Korea',         values: [0.8]  },
      { name: 'Russia',        values: [0.3]  },
    ],
    labels: ['Share of electricity (%)'],
    unit:   '%',
  };

  results.energy_solar = {
    series: [
      { name: 'World',         values: [6.9]  },
      { name: 'Germany',       values: [12.5] },
      { name: 'Spain',         values: [21.4] },
      { name: 'Japan',         values: [11.0] },
      { name: 'China',         values: [7.4]  },
      { name: 'United States', values: [6.5]  },
      { name: 'India',         values: [6.4]  },
      { name: 'United Kingdom',values: [5.0]  },
      { name: 'France',        values: [4.4]  },
      { name: 'Korea',         values: [5.5]  },
      { name: 'Brazil',        values: [4.5]  },
      { name: 'Russia',        values: [0.3]  },
    ],
    labels: ['Share of electricity (%)'],
    unit:   '%',
  };

  console.log(`${TAG} energy: ${Object.keys(results).length - afterDemo} loaded`);
  const afterEnergy = Object.keys(results).length;

  // ── Geopolitical ─────────────────────────────────────────────────────────
  console.log(`${TAG} fetching geopolitical...`);
  const [military] = await Promise.allSettled([
    wbFetch('MS.MIL.XPND.CD', ['USA', 'CHN', 'RUS', 'IND', 'SAU', 'GBR']),  // Military spending
  ]);

  assign('military', military);

  // ── Trade agreements + sanctions ────────────────────────────────────────
  // Curated lists. The frontend GLOBE_SECTIONS declares trade_blocs and
  // sanctions widgets but no public free API serves either field cleanly:
  //   • WTO's RTA database (rtais.wto.org) is authoritative but HTML-only,
  //     no JSON, requires a brittle scraper.
  //   • US OFAC publishes a 30 MB XML SDN list — accurate but un-aggregable
  //     without per-country tagging that's not in the source data.
  //   • UN sanctions are scattered across Security Council resolutions.
  //   • OpenSanctions.org has a free API that consolidates many of these,
  //     but rate limits + integration work make it a follow-up project.
  //
  // The data here is a quarterly-maintained snapshot. Refresh markers:
  //   • New major RTA enters force → add a series entry.
  //   • Significant sanctions package shifts country counts → bump.
  //   • Castellum.AI's Global Sanctions Index is a useful cross-reference
  //     for the listing counts (Q1 2026 figures used below, rounded).
  //
  // The shape mirrors what wbFetch returns for multi-country indicators
  // ({ series, labels, unit }), so the frontend's existing renderer
  // (server.js / GLOBE_SECTIONS render path) shows the headline value
  // plus an inline series breakdown without any frontend changes.
  const TRADE_BLOCS = {
    series: [
      { name: 'AfCFTA',           values: [54] }, // African Continental FTA
      { name: 'EU',               values: [27] },
      { name: 'COMESA',           values: [21] },
      { name: 'SADC',             values: [16] },
      { name: 'CARICOM',          values: [15] },
      { name: 'ECOWAS',           values: [15] },
      { name: 'RCEP',             values: [15] },
      { name: 'CPTPP',            values: [12] }, // 11 + UK joined 2024
      { name: 'ASEAN',            values: [10] },
      { name: 'SAARC',            values: [8]  },
      { name: 'GCC',              values: [6]  },
      { name: 'MERCOSUR',         values: [5]  },
      { name: 'EAEU',             values: [5]  },
      { name: 'EFTA',             values: [4]  },
      { name: 'Pacific Alliance', values: [4]  },
      { name: 'USMCA',            values: [3]  },
      { name: 'AUKUS',            values: [3]  },
      { name: 'Quad (Indo-Pacific)', values: [4] },
    ],
    labels: ['Members'],
    unit:   'members',
  };
  results.trade_blocs = TRADE_BLOCS;

  const SANCTIONS = {
    // Aggregate listing counts (OFAC SDN + EU CFSP + UN SC + UK + Canada
    // + Australia + Japan + Switzerland), Q1 2026 approximate. Russia
    // dominates post-2022; Iran second; the long tail covers established
    // sanctions regimes. "Listings" counts both individuals and entities.
    series: [
      { name: 'Russia',      values: [21000] },
      { name: 'Iran',        values: [4500]  },
      { name: 'Belarus',     values: [1500]  },
      { name: 'Syria',       values: [1200]  },
      { name: 'Myanmar',     values: [900]   },
      { name: 'North Korea', values: [800]   },
      { name: 'Venezuela',   values: [550]   },
      { name: 'Cuba',        values: [400]   },
      { name: 'Yemen',       values: [250]   },
      { name: 'South Sudan', values: [200]   },
      { name: 'Libya',       values: [150]   },
      { name: 'Mali',        values: [120]   },
      { name: 'Sudan',       values: [110]   },
      { name: 'Iraq',        values: [90]    },
      { name: 'Lebanon',     values: [80]    },
      { name: 'CAR',         values: [70]    },
      { name: 'Somalia',     values: [60]    },
      { name: 'Zimbabwe',    values: [50]    },
      { name: 'Burundi',     values: [40]    },
      { name: 'Nicaragua',   values: [40]    },
      { name: 'DR Congo',    values: [35]    },
    ],
    labels: ['Listings'],
    unit:   'listings',
  };
  results.sanctions = SANCTIONS;

  console.log(`${TAG} geopolitical: ${Object.keys(results).length - afterEnergy} loaded`);

  // ── Unique metrics ──────────────────────────────────────────────────────
  // The frontend declares six "Unique Metrics" widgets that have no clean
  // free API:
  //   • water_stress: WRI Aqueduct's per-country score is paywalled
  //   • food_import: FAO's calorie-import-dependency takes per-country
  //                  spreadsheets; not a JSON API
  //   • rare_supply: USGS Mineral Commodity Summaries are PDF tables
  //   • satellites:  UCS Satellite Database (now hosted at SwartCorp)
  //                  is XLSX-only; ITU has live data behind credentials
  //   • swf:         SWF Institute ranks by AUM; their data is paywalled
  //   • languages:   Ethnologue's API is paid
  //
  // Curated lists below. Same multi-series shape as trade_blocs /
  // sanctions so the existing frontend renderer (headline + inline
  // breakdown) treats them the same way. Refresh markers in each block.
  const afterGeopol = Object.keys(results).length;
  console.log(`${TAG} curating unique metrics...`);

  // Water stress: Aqueduct 4.0 baseline water-stress score (0-5 scale,
  // 5 = Extremely High). Top-stressed countries, 2024 dataset.
  results.water_stress = {
    series: [
      { name: 'Bahrain',      values: [4.93] },
      { name: 'Cyprus',       values: [4.85] },
      { name: 'Kuwait',       values: [4.79] },
      { name: 'Lebanon',      values: [4.79] },
      { name: 'Oman',         values: [4.74] },
      { name: 'Qatar',        values: [4.67] },
      { name: 'UAE',          values: [4.65] },
      { name: 'Saudi Arabia', values: [4.62] },
      { name: 'Israel',       values: [4.50] },
      { name: 'Egypt',        values: [4.32] },
      { name: 'Libya',        values: [4.21] },
      { name: 'Yemen',        values: [4.18] },
      { name: 'Botswana',     values: [4.06] },
      { name: 'Iran',         values: [4.05] },
      { name: 'Jordan',       values: [4.03] },
      { name: 'Chile',        values: [3.96] },
      { name: 'San Marino',   values: [3.90] },
      { name: 'Belgium',      values: [3.74] },
      { name: 'Greece',       values: [3.71] },
      { name: 'Tunisia',      values: [3.68] },
    ],
    labels: ['Aqueduct score (0-5)'],
    unit:   'score',
  };

  // Food import dependency: FAO's cereal import dependency ratio (CIDR).
  // % of cereal supply met by net imports, 2022 average. Negative values
  // indicate net exporters (omitted here — widget shows dependents).
  results.food_import = {
    series: [
      { name: 'Singapore',    values: [99] },
      { name: 'Bahrain',      values: [98] },
      { name: 'Brunei',       values: [97] },
      { name: 'Maldives',     values: [97] },
      { name: 'Cabo Verde',   values: [95] },
      { name: 'Djibouti',     values: [93] },
      { name: 'Yemen',        values: [92] },
      { name: 'Mauritania',   values: [89] },
      { name: 'Lebanon',      values: [88] },
      { name: 'Cuba',         values: [80] },
      { name: 'Saudi Arabia', values: [79] },
      { name: 'Algeria',      values: [76] },
      { name: 'Israel',       values: [73] },
      { name: 'Japan',        values: [62] },
      { name: 'South Korea',  values: [54] },
      { name: 'Egypt',        values: [42] },
      { name: 'United Kingdom', values: [40] },
      { name: 'Mexico',       values: [37] },
      { name: 'China',        values: [11] },
      { name: 'India',        values: [3]  },
    ],
    labels: ['Net imports as % of supply'],
    unit:   '% supply',
  };

  // Rare earth supply: country share of global mine production. USGS
  // Mineral Commodity Summaries 2024. China dominates mining; their
  // processing share is even higher (~85%) but mining is the more
  // commonly cited number.
  results.rare_supply = {
    series: [
      { name: 'China',        values: [69]  },
      { name: 'United States', values: [12] },
      { name: 'Australia',    values: [6]   },
      { name: 'Myanmar',      values: [4]   },
      { name: 'Thailand',     values: [3]   },
      { name: 'Vietnam',      values: [2]   },
      { name: 'India',        values: [1]   },
      { name: 'Russia',       values: [1]   },
      { name: 'Madagascar',   values: [1]   },
      { name: 'Brazil',       values: [0.5] },
    ],
    labels: ['% global mine production'],
    unit:   '% mining',
  };

  // Satellites in orbit: count by operator country. UCS Satellite
  // Database 5/2023 baseline, updated with public launch records
  // through 2025-Q4. SpaceX Starlink dominates the US count; Russia
  // includes legacy military constellations.
  results.satellites = {
    series: [
      { name: 'United States', values: [6900] },
      { name: 'China',         values: [780]  },
      { name: 'United Kingdom',values: [630]  },
      { name: 'Russia',        values: [180]  },
      { name: 'Japan',         values: [110]  },
      { name: 'India',         values: [98]   },
      { name: 'Germany',       values: [65]   },
      { name: 'Canada',        values: [60]   },
      { name: 'France',        values: [50]   },
      { name: 'Luxembourg',    values: [47]   },
      { name: 'South Korea',   values: [44]   },
      { name: 'Italy',         values: [38]   },
      { name: 'Spain',         values: [30]   },
      { name: 'Australia',     values: [27]   },
      { name: 'Brazil',        values: [22]   },
      { name: 'Argentina',     values: [21]   },
      { name: 'Israel',        values: [16]   },
      { name: 'Other',         values: [340]  },
    ],
    labels: ['Active satellites'],
    unit:   'count',
  };

  // Sovereign wealth funds: AUM in USD billions. SWF Institute Q1 2026
  // rankings. Aggregated where a country has multiple funds (e.g., UAE
  // = ADIA + ADQ + Mubadala + EIA combined).
  results.swf = {
    series: [
      { name: 'Norway',        values: [1700] }, // GPFG
      { name: 'China',         values: [1640] }, // CIC + SAFE
      { name: 'UAE',           values: [1600] }, // ADIA + Mubadala + ADQ + EIA
      { name: 'Saudi Arabia',  values: [925]  }, // PIF
      { name: 'Singapore',     values: [770]  }, // GIC + Temasek
      { name: 'Kuwait',        values: [970]  }, // KIA
      { name: 'Hong Kong',     values: [580]  }, // HKMA Investment Portfolio
      { name: 'Qatar',         values: [530]  }, // QIA
      { name: 'United States', values: [310]  }, // Alaska Permanent + Texas etc.
      { name: 'South Korea',   values: [220]  }, // KIC
      { name: 'Australia',     values: [165]  }, // Future Fund
      { name: 'Iran',          values: [140]  }, // NDF
      { name: 'Russia',        values: [125]  }, // National Wealth Fund
      { name: 'Libya',         values: [70]   }, // LIA
      { name: 'Kazakhstan',    values: [60]   }, // Samruk-Kazyna
      { name: 'Azerbaijan',    values: [55]   }, // SOFAZ
      { name: 'New Zealand',   values: [50]   }, // NZ Super Fund
      { name: 'Botswana',      values: [5.5]  }, // Pula Fund
    ],
    labels: ['AUM ($B)'],
    unit:   '$B AUM',
  };

  // Linguistic diversity: number of living indigenous languages.
  // Source: Ethnologue 27th edition (2024). Top countries by raw
  // language count — useful proxy for cultural complexity.
  results.languages = {
    series: [
      { name: 'Papua New Guinea', values: [840] },
      { name: 'Indonesia',        values: [710] },
      { name: 'Nigeria',          values: [520] },
      { name: 'India',            values: [460] },
      { name: 'Mexico',           values: [290] },
      { name: 'Cameroon',         values: [275] },
      { name: 'Australia',        values: [245] },
      { name: 'Brazil',           values: [225] },
      { name: 'United States',    values: [220] },
      { name: 'China',            values: [200] },
      { name: 'DR Congo',         values: [205] },
      { name: 'Philippines',      values: [185] },
      { name: 'Sudan',            values: [115] },
      { name: 'Tanzania',         values: [120] },
      { name: 'Vanuatu',          values: [110] },
      { name: 'Chad',             values: [130] },
      { name: 'Russia',           values: [105] },
      { name: 'Nepal',            values: [125] },
      { name: 'Myanmar',          values: [110] },
      { name: 'Vietnam',          values: [110] },
    ],
    labels: ['Living languages'],
    unit:   'languages',
  };
  console.log(`${TAG} unique metrics: ${Object.keys(results).length - afterGeopol} loaded`);

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
