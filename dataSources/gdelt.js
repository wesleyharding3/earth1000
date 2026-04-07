'use strict';
const { fetchJson } = require('./_util');

// GDELT 2.0 — global event/sentiment counts. No key.
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

const CATALOG = [
  { id: 'tone',     label: 'Average article tone',          mode: 'tonechart' },
  { id: 'volume',   label: 'Article volume timeline',       mode: 'timelinevolraw' },
  { id: 'volraw',   label: 'Raw article volume',            mode: 'timelinevolraw' },
];

async function fetch(query) {
  const indicator = CATALOG.find(c => c.id === query.indicator) || CATALOG[1];
  const q = encodeURIComponent(query.query || '');
  if (!q) throw new Error('gdelt: query required');
  const span = query.span || '3months';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=${indicator.mode}&format=json&timespan=${span}`;
  const json = await fetchJson(url);

  if (indicator.mode === 'timelinevolraw') {
    const tl = json?.timeline?.[0]?.data;
    if (!Array.isArray(tl) || !tl.length) throw new Error('gdelt: empty timeline');
    return {
      labels:     tl.map(d => d.date.slice(0, 10)),
      series:     [{ name: 'Article volume', values: tl.map(d => parseFloat(d.value)) }],
      unit:       'articles',
      source_url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=timelinevolraw`,
    };
  } else {
    const tl = json?.timeline?.[0]?.data;
    if (!Array.isArray(tl) || !tl.length) throw new Error('gdelt: empty tone series');
    return {
      labels:     tl.map(d => d.date.slice(0, 10)),
      series:     [{ name: 'Average tone', values: tl.map(d => parseFloat(d.value)) }],
      unit:       'tone (-100..+100)',
      source_url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=tonechart`,
    };
  }
}

module.exports = {
  name: 'gdelt',
  label: 'GDELT 2.0',
  description: 'Global news article volume and sentiment timeline by query string.',
  needsKey: [],
  catalog: CATALOG,
  fetch,
};
