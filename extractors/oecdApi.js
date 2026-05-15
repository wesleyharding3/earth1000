/**
 * oecdApi.js — OECD Data Explorer SDMX-JSON API.
 *
 * OECD's public API serves SDMX-JSON, which is significantly more
 * complex than the World Bank API: dimension axes, codelists, and
 * observation arrays indexed by dimension position. We expose a
 * narrow surface here — pick a dataset + indicator + units + time
 * range, get back per-country values.
 *
 * Endpoint:
 *   GET https://sdmx.oecd.org/public/rest/data/{AGENCY},{DATASET},{VERSION}/{FILTER}
 *       ?startPeriod={YEAR}&endPeriod={YEAR}&dimensionAtObservation=AllDimensions&format=jsondata
 *
 * Common OECD datasets accessible without keys:
 *   OECD.SDD.NAD,DSD_NAAG@DF_NAAG,1.0 — national accounts aggregates
 *   OECD.ECO.MAD,DSD_HEALTH@DF_HEALTH_PROC,1.0 — health expenditure
 *   OECD.GOV.PRO,DSD_GOV@DF_GOV,1.0 — government finance
 *   OECD.ELS.SAE,DSD_PISA@DF_PISA_2022,1.0 — PISA student scores
 *   OECD.STD.TPS,DSD_TIMS@DF_TIMSS_2019,1.0 — TIMSS scores
 *
 * Use as fallback when WB lacks an OECD-specific indicator (PISA,
 * health spending granularity, regulatory indices). For most economic
 * questions, World Bank is simpler.
 *
 * NOTE: OECD's public API can be slow (~3-8 sec). Wikipedia tables for
 * OECD-sourced data are often faster but less current. Pick OECD when
 * the question explicitly needs OECD-only or the latest figures.
 */

'use strict';

const FETCH_TIMEOUT_MS = 25000;   // OECD is slow, give it room
const USER_AGENT = 'Earth00MapThis/1.0 (https://earth00.com)';

const toolDef = {
  name: 'query_oecd_indicator',
  description:
    'Query the OECD Data Explorer for a per-country indicator. Use as a fallback when World ' +
    'Bank lacks the specific OECD-collected indicator: PISA scores, TIMSS scores, health ' +
    'expenditure as % of GDP, government finance ratios, OECD-specific labour metrics, ' +
    'regulatory quality indices. SLOWER than WB (~5 sec typical). For broad economic data ' +
    'prefer World Bank. ' +
    'Provide the dataflow identifier (AGENCY,DATASET,VERSION) and the filter expression ' +
    '(dotted list of dimension code values, empty positions matched with double-dot).',
  input_schema: {
    type: 'object',
    required: ['dataflow', 'filter'],
    properties: {
      dataflow: {
        type: 'string',
        description: 'Full dataflow identifier in the form "AGENCY,DATASET,VERSION". Example: "OECD.ELS.SAE,DSD_PISA@DF_PISA_2022,1.0".',
      },
      filter: {
        type: 'string',
        description: 'Dimensional filter as a dotted list. Use ".." for "all values" in a dimension. Example: "..MA..." selects the "MA" indicator code at the specified position.',
      },
      start_year: { type: 'string', description: 'Optional start year YYYY (default 2020).' },
      end_year:   { type: 'string', description: 'Optional end year YYYY (default current year).' },
    },
  },
};

async function _fetchJson(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.sdmx.data+json;version=1.0.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OECD API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function run(spec, resolveName, env = {}) {
  const { dataflow, filter, start_year, end_year } = spec;
  if (!dataflow || !filter) {
    return { error: 'query_oecd_indicator: dataflow and filter both required' };
  }
  const startY = start_year || '2020';
  const endY   = end_year || String(new Date().getFullYear());
  const url = `https://sdmx.oecd.org/public/rest/data/${encodeURI(dataflow)}/${encodeURI(filter)}?startPeriod=${startY}&endPeriod=${endY}&dimensionAtObservation=AllDimensions&format=jsondata`;

  let payload;
  try {
    payload = await _fetchJson(url);
  } catch (err) {
    return { error: `OECD fetch failed: ${err.message}` };
  }

  // SDMX-JSON has dimensions in data.structure.dimensions.observation,
  // observations keyed by dim-index colon-separated. Parse out the
  // REF_AREA (country) dimension and the value.
  const structure = payload?.data?.structures?.[0] || payload?.structure;
  if (!structure) {
    return { error: 'OECD response has no structure metadata' };
  }
  const obsDims = structure.dimensions?.observation || [];
  const refAreaDim = obsDims.findIndex(d => /REF_?AREA|GEO|LOCATION/i.test(d.id));
  if (refAreaDim === -1) {
    return { error: 'OECD response has no REF_AREA / LOCATION dimension' };
  }
  const refAreaValues = obsDims[refAreaDim].values || [];

  // Time dimension (for picking latest year per country)
  const timeDim = obsDims.findIndex(d => /TIME_PERIOD|TIME/i.test(d.id));
  const timeValues = timeDim >= 0 ? obsDims[timeDim].values : [];

  const observations = payload?.data?.dataSets?.[0]?.observations
                     || payload?.dataSets?.[0]?.observations
                     || {};
  const alpha3to2 = env.isoAlpha3ToAlpha2 || {};

  // For each obs key like "0:5:2" pick out the country index and year
  // index, dereference, and keep the latest year per country.
  const byIso = new Map();
  for (const [obsKey, obsVal] of Object.entries(observations)) {
    const parts = obsKey.split(':');
    const cIdx = parseInt(parts[refAreaDim], 10);
    const country = refAreaValues[cIdx];
    if (!country) continue;
    const iso3 = String(country.id || '').toUpperCase();
    // OECD often uses ISO3, but some datasets use ISO2 or custom codes
    const iso2 = (iso3.length === 2 ? iso3 : alpha3to2[iso3]) || resolveName(country.name || country.id);
    if (!iso2) continue;
    const v = Array.isArray(obsVal) ? obsVal[0] : obsVal;
    if (v == null || !Number.isFinite(Number(v))) continue;
    const yr = timeDim >= 0
      ? parseInt(timeValues[parseInt(parts[timeDim], 10)]?.id, 10)
      : 0;
    const prev = byIso.get(iso2);
    if (!prev || yr > prev.year) {
      byIso.set(iso2, { value: Number(v), year: yr || null });
    }
  }

  const values = [...byIso.entries()].map(([iso, info]) => ({
    iso,
    value: info.value,
    year: info.year,
  }));
  const newestYear = Math.max(...values.map(v => v.year || 0)) || null;

  return {
    values,
    source_note: `OECD Data Explorer — ${dataflow}${newestYear ? `, year=${newestYear}` : ''}`,
    row_count: values.length,
  };
}

module.exports = { toolDef, run };
