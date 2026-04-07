'use strict';
const { fetchJson } = require('./_util');

// ACLED — Armed Conflict Location & Event Data.
// Free academic / research API key required.
// Docs: https://acleddata.com/acleddatanew/

const CATALOG = [
  { id: 'all',                  label: 'All conflict events',     event_type: null },
  { id: 'battles',              label: 'Battles',                 event_type: 'Battles' },
  { id: 'violence-civilians',   label: 'Violence against civilians', event_type: 'Violence against civilians' },
  { id: 'protests',             label: 'Protests',                event_type: 'Protests' },
  { id: 'riots',                label: 'Riots',                   event_type: 'Riots' },
  { id: 'explosions',           label: 'Explosions / remote violence', event_type: 'Explosions/Remote violence' },
];

async function fetch(query) {
  const key   = process.env.ACLED_API_KEY;
  const email = process.env.ACLED_EMAIL;
  if (!key || !email) throw new Error('acled: missing ACLED_API_KEY / ACLED_EMAIL');

  const country = query.country;
  if (!country) throw new Error('acled: country required');
  const indicator = (CATALOG.find(c => c.id === query.indicator) || CATALOG[0]);
  const months = query.months || 12;
  // Group by month
  const url = `https://api.acleddata.com/acled/read?key=${key}&email=${encodeURIComponent(email)}&country=${encodeURIComponent(country)}${indicator.event_type ? `&event_type=${encodeURIComponent(indicator.event_type)}` : ''}&limit=20000&fields=event_date|fatalities`;
  const json = await fetchJson(url, { timeoutMs: 20000 });
  const rows = json?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('acled: no events');

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const byMonth = {};   // 'YYYY-MM' → { events, fatalities }
  for (const r of rows) {
    const d = new Date(r.event_date);
    if (isNaN(d) || d < cutoff) continue;
    const key = d.toISOString().slice(0, 7);
    const slot = byMonth[key] = byMonth[key] || { events: 0, fatalities: 0 };
    slot.events += 1;
    slot.fatalities += parseInt(r.fatalities || 0, 10);
  }

  const labels = Object.keys(byMonth).sort();
  if (!labels.length) throw new Error('acled: no events in window');

  return {
    labels,
    series: [
      { name: 'Events',     values: labels.map(l => byMonth[l].events) },
      { name: 'Fatalities', values: labels.map(l => byMonth[l].fatalities) },
    ],
    unit: 'count',
    source_url: `https://acleddata.com/dashboard/#/dashboard?country=${encodeURIComponent(country)}`,
  };
}

module.exports = {
  name: 'acled',
  label: 'ACLED',
  description: 'Conflict events, protests, riots, fatalities by country and month.',
  needsKey: ['ACLED_API_KEY', 'ACLED_EMAIL'],
  catalog: CATALOG,
  fetch,
};
