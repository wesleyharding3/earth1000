'use strict';
const { fetchJson } = require('./_util');

// FRED — Federal Reserve Economic Data — free key.
// Docs: https://fred.stlouisfed.org/docs/api/fred/

const CATALOG = [
  { id: 'CPIAUCSL',   label: 'US CPI (all urban consumers)',                  unit: 'index 1982-84=100' },
  { id: 'UNRATE',     label: 'US unemployment rate',                          unit: '%' },
  { id: 'FEDFUNDS',   label: 'Federal funds rate',                            unit: '%' },
  { id: 'GDP',        label: 'US GDP (nominal)',                              unit: 'billion US$' },
  { id: 'DGS10',      label: '10-year Treasury yield',                        unit: '%' },
  { id: 'DCOILWTICO', label: 'WTI crude oil spot',                            unit: 'US$/barrel' },
  { id: 'DEXUSEU',    label: 'US$ / Euro exchange rate',                      unit: 'US$ per EUR' },
  { id: 'DEXCHUS',    label: 'Yuan / US$ exchange rate',                      unit: 'CNY per US$' },
  { id: 'PAYEMS',     label: 'US nonfarm payrolls',                           unit: 'thousands' },
  { id: 'GFDEBTN',    label: 'US federal debt (total public)',                unit: 'million US$' },
  { id: 'GOLDAMGBD228NLBM', label: 'Gold spot price (London)',              unit: 'US$/troy oz' },
  { id: 'DCOILBRENTEU',     label: 'Brent crude oil spot',                  unit: 'US$/barrel' },
  { id: 'PCOPPUSDM',        label: 'Copper price (global)',                  unit: 'US$/lb' },
  { id: 'PALUMUSDM',        label: 'Aluminum price (global)',                unit: 'US$/metric ton' },
  { id: 'PCOALAUUSDM',      label: 'Coal price (Australian)',                unit: 'US$/metric ton' },
  { id: 'PWHEAMTUSDM',      label: 'Wheat price (global)',                   unit: 'US$/metric ton' },
  { id: 'PCOREUSDM',        label: 'Corn price (global)',                    unit: 'US$/metric ton' },
  { id: 'PCOFFOTMUSDM',     label: 'Coffee price (global)',                  unit: 'US¢/lb' },
  { id: 'PCOCOAUSDM',       label: 'Cocoa price (global)',                   unit: 'US$/metric ton' },
  { id: 'PCOTTUSDM',        label: 'Cotton price (global)',                  unit: 'US¢/lb' },
  { id: 'PSOYBUSDM',        label: 'Soybean price (global)',                 unit: 'US$/metric ton' },
  { id: 'PSILVERUSDM',      label: 'Silver price (global)',                  unit: 'US$/troy oz' },
  { id: 'PPLATINUSDM',      label: 'Platinum price (global)',                unit: 'US$/troy oz' },
  { id: 'WPU101',           label: 'Lumber PPI',                             unit: 'index' },
];

async function fetch(query) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('fred: missing FRED_API_KEY');
  const seriesId = query.indicator || CATALOG[0].id;
  const limit = query.limit || 60;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
  const json = await fetchJson(url);
  const obs = json?.observations;
  if (!Array.isArray(obs) || !obs.length) throw new Error(`fred: no observations for ${seriesId}`);
  obs.reverse();
  const labels = obs.map(o => o.date);
  const values = obs.map(o => (o.value === '.' ? null : parseFloat(o.value)));
  return {
    labels,
    series:     [{ name: (CATALOG.find(c => c.id === seriesId) || {}).label || seriesId, values }],
    unit:       (CATALOG.find(c => c.id === seriesId) || {}).unit,
    source_url: `https://fred.stlouisfed.org/series/${seriesId}`,
  };
}

module.exports = {
  name: 'fred',
  label: 'FRED (St. Louis Fed)',
  description: 'US + global macroeconomic indicators (inflation, rates, GDP, FX, debt).',
  needsKey: ['FRED_API_KEY'],
  catalog: CATALOG,
  fetch,
};
