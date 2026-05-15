/**
 * whoGhoApi.js — WHO Global Health Observatory OData API.
 * Public, free, no auth, JSON output.
 *
 * Endpoint:
 *   GET https://ghoapi.azureedge.net/api/{INDICATOR_CODE}
 *
 * Returns: { value: [{ SpatialDim, TimeDim, NumericValue, Dim1, ... }, ...] }
 * where SpatialDim is ISO3 (3-letter country code) and TimeDim is year.
 *
 * Catalogue: https://ghoapi.azureedge.net/api/Indicator
 * Common codes for Map This:
 *   WHOSIS_000001 — life expectancy at birth (both sexes)
 *   WHOSIS_000015 — healthy life expectancy
 *   MDG_0000000001 — under-5 mortality
 *   M_Est_smk_curr_std — current tobacco smoking rate
 *   NCDMORT3070 — premature NCD mortality
 *   SH.STA.OWAD.ZS — adult obesity rate (WHO mirror of WB code)
 *   AIR_1 — PM2.5 air pollution exposure
 *   WSH_WATER_BASIC — basic drinking water service %
 *
 * Use when the question is health-domain AND World Bank lacks the
 * specific indicator (WHO has finer granularity for health data).
 */

'use strict';

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'Earth00MapThis/1.0 (https://earth00.com)';

const toolDef = {
  name: 'query_who_gho_indicator',
  description:
    'Query the World Health Organization Global Health Observatory API. Use for health-domain ' +
    'questions where WB lacks specifics: mortality breakdowns, disease prevalence, vaccination ' +
    'coverage, air-pollution exposure, healthcare workforce density, tobacco / alcohol use, ' +
    'obesity, mental health indicators. Returns per-country values for the most recent year of ' +
    'available data. ' +
    'Common codes: WHOSIS_000001 (life expectancy), MDG_0000000001 (under-5 mortality), ' +
    'NCDMORT3070 (premature NCD mortality), AIR_1 (PM2.5 exposure µg/m³), ' +
    'M_Est_smk_curr_std (current smoking rate %), WSH_WATER_BASIC (basic water service %). ' +
    'If unsure of the indicator code, prefer World Bank or Wikipedia.',
  input_schema: {
    type: 'object',
    required: ['indicator_code'],
    properties: {
      indicator_code: {
        type: 'string',
        description: 'WHO GHO indicator code (e.g. "WHOSIS_000001" for life expectancy). Catalogue at https://ghoapi.azureedge.net/api/Indicator.',
      },
      // Optional sex filter — WHO GHO returns rows split by SEX dim
      // for many indicators ("BTSX" = both sexes, "MLE" = male, "FMLE"
      // = female). We default to BTSX. Year is auto-picked (latest
      // per country).
      sex: {
        type: 'string',
        enum: ['BTSX', 'MLE', 'FMLE'],
        description: 'Optional sex filter when the indicator splits by sex. Default: BTSX (both sexes).',
      },
    },
  },
};

async function _fetchJson(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`WHO GHO HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function run(spec, resolveName, env = {}) {
  const { indicator_code, sex } = spec;
  if (!indicator_code || typeof indicator_code !== 'string') {
    return { error: 'query_who_gho_indicator: indicator_code required' };
  }
  const url = `https://ghoapi.azureedge.net/api/${encodeURIComponent(indicator_code)}`;
  let payload;
  try {
    payload = await _fetchJson(url);
  } catch (err) {
    return { error: `WHO GHO fetch failed: ${err.message}` };
  }
  const rows = Array.isArray(payload?.value) ? payload.value : [];
  if (!rows.length) {
    return { error: `WHO GHO returned no data for indicator ${indicator_code}` };
  }

  const sexWanted = (sex || 'BTSX').toUpperCase();
  const alpha3to2 = env.isoAlpha3ToAlpha2 || {};

  // Per country, keep the most recent year that matches the sex filter.
  const byIso = new Map();
  for (const r of rows) {
    if (r.Dim1 && r.Dim1.toUpperCase() !== sexWanted) continue;
    const iso3 = String(r.SpatialDim || '').toUpperCase();
    if (!iso3 || iso3.length !== 3) continue;
    const iso2 = alpha3to2[iso3] || resolveName(iso3);
    if (!iso2) continue;
    const yr = parseInt(r.TimeDim, 10);
    const val = Number(r.NumericValue);
    if (!Number.isFinite(val)) continue;
    const prev = byIso.get(iso2);
    if (!prev || yr > prev.year) {
      byIso.set(iso2, { value: val, year: yr });
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
    source_note: `WHO GHO — ${indicator_code}${newestYear ? `, most-recent year=${newestYear}` : ''}${sex ? ` (${sex})` : ''}`,
    row_count: values.length,
  };
}

module.exports = { toolDef, run };
