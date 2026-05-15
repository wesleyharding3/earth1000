/**
 * worldBankApi.js — fetch a per-country indicator from the World Bank
 * Open Data API. Best parser for economic / development / population /
 * health / education metrics — the WB indicator catalog has ~1500
 * indicators with consistent ISO3 keying and dependable refresh.
 *
 * API docs: https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation
 *
 * Endpoint pattern:
 *   GET https://api.worldbank.org/v2/country/all/indicator/{CODE}
 *       ?format=json
 *       &date={YEAR}                       (single year or YYYY:YYYY range)
 *       &per_page=400                      (covers ~265 territories incl. aggregates)
 *
 * The first response element is metadata; the second is the array of
 * { country: {id, value}, countryiso3code, value, date } records.
 *
 * Auth: none, public API. Rate limit informally ~60 req/min/IP — well
 * within Map-This usage. We don't cache here because the heatmap_qa_cache
 * (Postgres) caches the FULL resolved heatmap, so the same WB call
 * would only re-run if the question itself isn't cached.
 */

'use strict';

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'Earth00MapThis/1.0 (https://earth00.com)';

const toolDef = {
  name: 'query_world_bank_indicator',
  description:
    'Query the World Bank Open Data API for a single development indicator across all countries. ' +
    'Use this FIRST (before Wikipedia) for: GDP, GDP per capita, population, life expectancy, ' +
    'literacy, mortality, energy use, CO2 emissions, internet penetration, trade balance, FDI, ' +
    'inflation, unemployment, school enrollment, poverty headcount, urbanization, etc. — ' +
    'anything in the WB indicator catalog. ' +
    'Common indicator codes: ' +
    'NY.GDP.MKTP.CD (GDP USD nominal), NY.GDP.PCAP.CD (GDP per capita USD), ' +
    'SP.POP.TOTL (population), SP.DYN.LE00.IN (life expectancy), ' +
    'AG.LND.TOTL.K2 (land area km²), EN.ATM.CO2E.PC (CO2 emissions per capita), ' +
    'IT.NET.USER.ZS (internet users %), SE.ADT.LITR.ZS (adult literacy %), ' +
    'SI.POV.NAHC (national poverty rate %), MS.MIL.XPND.CD (military spending USD). ' +
    'If unsure of the exact code, prefer extract_wikipedia_table instead.',
  input_schema: {
    type: 'object',
    required: ['indicator_code'],
    properties: {
      indicator_code: {
        type: 'string',
        description: 'World Bank indicator code (e.g. "NY.GDP.MKTP.CD" for GDP). Always include the full dotted code, not a label.',
      },
      year: {
        type: 'string',
        description: 'Optional year (YYYY) or range "YYYY:YYYY". Default: most recent available, queried as 2022:2024 to allow fallback.',
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
    if (!res.ok) throw new Error(`World Bank API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

/**
 * @param {object} spec — matches toolDef.input_schema
 * @param {function} resolveName — name → ISO resolver (used as backup;
 *                                  WB returns ISO3 directly which we
 *                                  convert via the alpha3 map)
 * @param {object} env — { isoAlpha3ToAlpha2 } map exposed from
 *                       isoCountryCodes for direct alpha3 → alpha2.
 */
async function run(spec, resolveName, env = {}) {
  const { indicator_code, year } = spec;
  if (!indicator_code || typeof indicator_code !== 'string') {
    return { error: 'query_world_bank_indicator: indicator_code required' };
  }
  // Default to most-recent 3 years so partial coverage is tolerated.
  const dateParam = year || '2022:2024';
  const url = `https://api.worldbank.org/v2/country/all/indicator/${encodeURIComponent(indicator_code)}?format=json&date=${encodeURIComponent(dateParam)}&per_page=400`;

  let payload;
  try {
    payload = await _fetchJson(url);
  } catch (err) {
    return { error: `World Bank fetch failed: ${err.message}` };
  }

  if (!Array.isArray(payload) || payload.length < 2) {
    return { error: `World Bank API returned unexpected shape (no rows). Indicator may not exist: ${indicator_code}` };
  }
  const [meta, rows] = payload;
  if (meta?.message?.length) {
    return { error: `World Bank API error: ${meta.message[0]?.value || JSON.stringify(meta.message[0])}` };
  }
  if (!Array.isArray(rows) || !rows.length) {
    return { error: `World Bank returned zero rows for ${indicator_code} (date=${dateParam})` };
  }

  // Group rows by ISO3, keeping the most recent non-null value per country.
  const alpha3to2 = env.isoAlpha3ToAlpha2 || {};
  const byIso = new Map();   // iso2 → { value, year, sourceCountry }
  for (const r of rows) {
    const iso3 = String(r.countryiso3code || r.country?.id || '').toUpperCase();
    if (!iso3 || iso3.length !== 3) continue;
    const iso2 = alpha3to2[iso3] || resolveName(r.country?.value || iso3);
    if (!iso2) continue;
    if (r.value == null || !Number.isFinite(Number(r.value))) continue;
    const yr = parseInt(r.date, 10);
    const prev = byIso.get(iso2);
    if (!prev || yr > prev.year) {
      byIso.set(iso2, { value: Number(r.value), year: yr, sourceCountry: r.country?.value || iso2 });
    }
  }

  const values = [...byIso.entries()].map(([iso, info]) => ({
    iso,
    value: info.value,
    source_row_country: info.sourceCountry,
    year: info.year,
  }));

  // Pick the most recent year that actually has data for the indicator
  // name — used in the source_note.
  const indicatorLabel = rows[0]?.indicator?.value || indicator_code;
  const newestYear = Math.max(...values.map(v => v.year || 0)) || null;

  return {
    values,
    source_note: `World Bank — ${indicatorLabel} (${indicator_code})${newestYear ? `, most-recent year=${newestYear}` : ''}`,
    row_count: values.length,
  };
}

module.exports = { toolDef, run };
