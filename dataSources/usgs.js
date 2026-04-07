'use strict';
const { fetchJson } = require('./_util');

// USGS Earthquake Hazards — public, no key.
// Docs: https://earthquake.usgs.gov/fdsnws/event/1/

const CATALOG = [
  { id: 'sig-30d',  label: 'Significant earthquakes (last 30 days)',  minMag: 4.5, days: 30 },
  { id: 'all-7d',   label: 'All earthquakes M2.5+ (last 7 days)',     minMag: 2.5, days: 7 },
  { id: 'major-1y', label: 'Major earthquakes M5.5+ (last year)',     minMag: 5.5, days: 365 },
];

async function fetch(query) {
  const opt = CATALOG.find(c => c.id === query.indicator) || CATALOG[0];
  const end = new Date();
  const start = new Date(end.getTime() - opt.days * 86400000);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start.toISOString().slice(0,10)}&endtime=${end.toISOString().slice(0,10)}&minmagnitude=${opt.minMag}`;
  const json = await fetchJson(url);
  const features = json?.features;
  if (!Array.isArray(features) || !features.length) throw new Error('usgs: no quakes');

  // Group by day
  const byDay = {};
  for (const f of features) {
    const d = new Date(f.properties.time).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  const labels = Object.keys(byDay).sort();
  return {
    labels,
    series:     [{ name: opt.label, values: labels.map(l => byDay[l]) }],
    unit:       'count',
    source_url: 'https://earthquake.usgs.gov/earthquakes/map/',
  };
}

module.exports = {
  name: 'usgs',
  label: 'USGS',
  description: 'Earthquake counts and magnitudes from the USGS feed.',
  needsKey: [],
  catalog: CATALOG,
  fetch,
};
