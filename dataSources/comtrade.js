'use strict';
const { fetchJson, toIso3 } = require('./_util');

// UN Comtrade — bilateral trade flows.
// Free public access; sub-key strongly recommended for higher rate limits.
// Docs: https://comtradeplus.un.org/

// Numeric country codes (M49) — small subset; for unknowns we fall back to ISO3 mapping
// then look up via the API's reference endpoint at runtime if needed.
// To keep things simple here we accept ISO3 (Comtrade also accepts ISO3).

const CATALOG = [
  { id: 'TOTAL',  label: 'Total merchandise trade',                  hsCode: 'TOTAL' },
  { id: '27',     label: 'Mineral fuels & oils (HS chapter 27)',     hsCode: '27' },
  { id: '2709',   label: 'Crude petroleum oils (HS 2709)',           hsCode: '2709' },
  { id: '2711',   label: 'Petroleum gases (HS 2711)',                hsCode: '2711' },
  { id: '10',     label: 'Cereals (HS chapter 10)',                  hsCode: '10' },
  { id: '1001',   label: 'Wheat (HS 1001)',                          hsCode: '1001' },
  { id: '85',     label: 'Electrical machinery (HS chapter 85)',     hsCode: '85' },
  { id: '8542',   label: 'Semiconductors / ICs (HS 8542)',           hsCode: '8542' },
  { id: '93',     label: 'Arms & ammunition (HS chapter 93)',        hsCode: '93' },
  { id: '7108',   label: 'Gold (HS 7108)',                           hsCode: '7108' },
];

async function fetch(query) {
  const key = process.env.COMTRADE_API_KEY;
  // Comtrade public preview works without a key for small queries; we still try.
  const reporter = toIso3(query.reporter);
  const partner  = query.partner ? toIso3(query.partner) : 'WLD'; // World
  if (!reporter) throw new Error('comtrade: unknown reporter country');
  const indicator = (CATALOG.find(c => c.id === query.indicator) || CATALOG[0]);
  const flowCode  = (query.flow || 'X').toUpperCase();             // X=export, M=import
  const years     = (query.years && query.years.length) ? query.years : (() => {
    const y = new Date().getFullYear();
    return [y - 5, y - 4, y - 3, y - 2, y - 1];
  })();

  // Comtrade Plus REST endpoint
  // /data/v1/get/C/A/HS?reporterCode=...&partnerCode=...&period=YEAR&cmdCode=HS&flowCode=X
  // Returns netWeight, primaryValue (USD), etc.
  const periods = years.join(',');
  const headers = key ? { 'Ocp-Apim-Subscription-Key': key } : {};
  // With key → premium endpoint (full data, higher limits)
  // Without key → public preview endpoint (limited records, recent only)
  const base = key
    ? 'https://comtradeapi.un.org/data/v1/get'
    : 'https://comtradeapi.un.org/public/v1/preview';
  const url = `${base}/C/A/HS?reporterCode=${reporter}&partnerCode=${partner}&period=${periods}&cmdCode=${indicator.hsCode}&flowCode=${flowCode}&typeCode=C&freqCode=A&clCode=HS`;

  const json = await fetchJson(url, { headers, timeoutMs: 15000 });
  const rows = json?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('comtrade: no rows returned');

  const byYear = {};
  for (const r of rows) byYear[r.period] = parseFloat(r.primaryValue || 0);
  const labels = years.map(String);
  const values = years.map(y => byYear[y] ?? null);

  return {
    labels,
    series:     [{ name: `${query.reporter} → ${query.partner || 'World'} (${flowCode === 'X' ? 'exports' : 'imports'})`, values }],
    unit:       'USD',
    source_url: `https://comtradeplus.un.org/TradeFlow?Frequency=A&Flows=${flowCode}&CommodityCodes=${indicator.hsCode}&ReporterCodes=${reporter}&PartnerCodes=${partner}`,
  };
}

module.exports = {
  name: 'comtrade',
  label: 'UN Comtrade',
  description: 'Bilateral merchandise trade flows by HS commodity code.',
  needsKey: [],   // optional key, but works without
  catalog: CATALOG,
  fetch,
};
