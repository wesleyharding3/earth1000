'use strict';
const { fetchJson } = require('./_util');

// US Energy Information Administration — free API key required.
// Docs: https://www.eia.gov/opendata/documentation.php
// Series IDs in CATALOG are stable v2-API series.

const CATALOG = [
  { id: 'PET.MCRFPUS2.M',     label: 'US crude oil production (monthly)',         unit: 'thousand barrels/day' },
  { id: 'PET.WCRFPUS2.W',     label: 'US crude oil production (weekly)',          unit: 'thousand barrels/day' },
  { id: 'PET.RWTC.D',         label: 'WTI crude oil spot price',                  unit: 'US$/barrel' },
  { id: 'PET.RBRTE.D',        label: 'Brent crude oil spot price',                unit: 'US$/barrel' },
  { id: 'NG.RNGWHHD.D',       label: 'Henry Hub natural gas spot price',          unit: 'US$/MMBtu' },
  { id: 'PET.EMM_EPMR_PTE_NUS_DPG.W', label: 'US regular gasoline retail price',  unit: 'US$/gallon' },
  { id: 'INTL.57-1-WORL-TBPD.A',  label: 'World oil production',                  unit: 'thousand barrels/day' },
  { id: 'INTL.5-2-WORL-TBPD.A',   label: 'World oil consumption',                 unit: 'thousand barrels/day' },
];

async function fetch(query) {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error('eia: missing EIA_API_KEY');
  const seriesId = query.indicator || CATALOG[0].id;

  // EIA v2 series-data endpoint
  const url = `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${key}`;
  const json = await fetchJson(url);
  const data = json?.response?.data;
  if (!Array.isArray(data) || !data.length) throw new Error(`eia: empty data for ${seriesId}`);

  // Sort ascending by period
  data.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  // Trim to most recent N points (default 24 if monthly, 30 daily/weekly)
  const limit = query.limit || 24;
  const trimmed = data.slice(-limit);

  return {
    labels:     trimmed.map(d => d.period),
    series:     [{ name: (CATALOG.find(c => c.id === seriesId) || {}).label || seriesId, values: trimmed.map(d => parseFloat(d.value)) }],
    unit:       (CATALOG.find(c => c.id === seriesId) || {}).unit,
    source_url: `https://www.eia.gov/opendata/qb.php?sdid=${seriesId}`,
  };
}

module.exports = {
  name: 'eia',
  label: 'US EIA',
  description: 'Oil, gas, electricity production / consumption / prices, US and global.',
  needsKey: ['EIA_API_KEY'],
  catalog: CATALOG,
  fetch,
};
