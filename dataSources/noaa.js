'use strict';
const { fetchJson } = require('./_util');

// NOAA — Global Surface Temperature Anomaly. Lightweight public JSON.
// Docs: https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series

const CATALOG = [
  { id: 'temp-anomaly-land-ocean', label: 'Global temperature anomaly (land+ocean)', dataset: 'land_ocean' },
  { id: 'temp-anomaly-land',       label: 'Global temperature anomaly (land only)',  dataset: 'land' },
  { id: 'temp-anomaly-ocean',      label: 'Global temperature anomaly (ocean only)', dataset: 'ocean' },
];

async function fetch(query) {
  const opt = CATALOG.find(c => c.id === query.indicator) || CATALOG[0];
  // NCEI 'Climate at a Glance' JSON endpoint
  const url = `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/${opt.dataset}/all/12/1900-2030/data.json`;
  const json = await fetchJson(url);
  const data = json?.data;
  if (!data || typeof data !== 'object') throw new Error('noaa: no data');

  const yearMin = query.year_min || 1980;
  const labels = [];
  const values = [];
  for (const k of Object.keys(data).sort()) {
    const yr = parseInt(k.slice(0, 4), 10);
    if (yr < yearMin) continue;
    labels.push(String(yr));
    values.push(parseFloat(data[k].value));
  }
  if (!labels.length) throw new Error('noaa: empty after filter');
  return {
    labels,
    series:     [{ name: opt.label, values }],
    unit:       '°C anomaly',
    source_url: 'https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/',
  };
}

module.exports = {
  name: 'noaa',
  label: 'NOAA NCEI',
  description: 'Global surface temperature anomalies (climate baselines).',
  needsKey: [],
  catalog: CATALOG,
  fetch,
};
