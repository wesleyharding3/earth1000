'use strict';
const { fetchText } = require('./_util');

// Our World in Data — public CSVs, no key.
// We pin a small curated catalog of CSV slugs that map to common briefing topics.
// CSVs live at: https://ourworldindata.org/grapher/<slug>.csv
// (returns rows: Entity,Code,Year,<value column>)

const CATALOG = [
  { id: 'homicide-rate',                     label: 'Homicide rate (per 100k)',          unit: 'per 100k', col: null },
  { id: 'deaths-from-conflict-and-terrorism',label: 'Deaths from conflict & terrorism',  unit: 'deaths',   col: null },
  { id: 'annual-co-emissions-by-region',     label: 'Annual CO2 emissions',              unit: 'tonnes',   col: null },
  { id: 'share-of-people-vaccinated-covid',  label: 'Share of people vaccinated (COVID)',unit: '%',        col: null },
  { id: 'gas-prices',                        label: 'Gasoline pump prices',              unit: 'US$/L',    col: null },
  { id: 'energy-consumption-by-source',      label: 'Energy consumption by source',      unit: 'TWh',      col: null },
  { id: 'refugee-population-by-country-or-territory-of-origin', label: 'Refugees by country of origin', unit: 'people', col: null },
  { id: 'natural-disaster-deaths',           label: 'Deaths from natural disasters',     unit: 'deaths',   col: null },
];

function parseCsv(text) {
  // Minimal CSV parser — OWID files are well-formed (no embedded commas in quotes for these series)
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

async function fetch(query) {
  const slug = (query.indicator || CATALOG[0].id);
  const url = `https://ourworldindata.org/grapher/${slug}.csv`;
  const text = await fetchText(url);
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('owid: empty CSV');

  // Detect the value column (anything that's not Entity/Code/Year)
  const header = Object.keys(rows[0]);
  const valueCol = header.find(h => !['Entity','Code','Year'].includes(h));
  if (!valueCol) throw new Error('owid: no value column');

  const wantedCountries = (query.countries || []).map(c => c.toLowerCase());
  const yearMin = query.year_min || (new Date().getFullYear() - 12);
  const yearMax = query.year_max || (new Date().getFullYear());

  // Group: country → { year: value }
  const byCountry = {};
  for (const row of rows) {
    const ent = row.Entity;
    const yr  = parseInt(row.Year, 10);
    const val = parseFloat(row[valueCol]);
    if (!ent || isNaN(yr) || isNaN(val)) continue;
    if (yr < yearMin || yr > yearMax) continue;
    if (wantedCountries.length && !wantedCountries.includes(ent.toLowerCase())) continue;
    (byCountry[ent] = byCountry[ent] || {})[yr] = val;
  }

  // Build aligned year axis
  const allYears = new Set();
  Object.values(byCountry).forEach(m => Object.keys(m).forEach(y => allYears.add(parseInt(y, 10))));
  const years = [...allYears].sort((a, b) => a - b);
  if (!years.length) throw new Error('owid: no rows after filtering');

  const series = Object.entries(byCountry).map(([name, m]) => ({
    name,
    values: years.map(y => m[y] ?? null),
  }));

  if (!series.length) throw new Error('owid: no series');
  return {
    labels:     years.map(String),
    series,
    unit:       (CATALOG.find(c => c.id === slug) || {}).unit || valueCol,
    source_url: `https://ourworldindata.org/grapher/${slug}`,
  };
}

module.exports = {
  name: 'owid',
  label: 'Our World in Data',
  description: 'Curated long-run datasets on conflict, energy, climate, health, refugees, vaccinations.',
  needsKey: [],
  catalog: CATALOG,
  fetch,
};
