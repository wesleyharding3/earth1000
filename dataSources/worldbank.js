'use strict';
const { fetchJson, toIso3, pickRecentYears } = require('./_util');

// World Bank Open Data — no key needed.
// https://datahelpdesk.worldbank.org/knowledgebase/articles/889392

const CATALOG = [
  { id: 'NY.GDP.MKTP.CD',     label: 'GDP (current US$)',                       unit: 'US$' },
  { id: 'NY.GDP.PCAP.CD',     label: 'GDP per capita (current US$)',            unit: 'US$' },
  { id: 'SP.POP.TOTL',        label: 'Population, total',                       unit: 'people' },
  { id: 'NE.TRD.GNFS.ZS',     label: 'Trade (% of GDP)',                        unit: '% of GDP' },
  { id: 'NE.EXP.GNFS.CD',     label: 'Exports of goods and services (US$)',     unit: 'US$' },
  { id: 'NE.IMP.GNFS.CD',     label: 'Imports of goods and services (US$)',     unit: 'US$' },
  { id: 'MS.MIL.XPND.CD',     label: 'Military expenditure (current US$)',      unit: 'US$' },
  { id: 'MS.MIL.XPND.GD.ZS',  label: 'Military expenditure (% of GDP)',         unit: '% of GDP' },
  { id: 'EG.USE.ELEC.KH.PC',  label: 'Electric power consumption (kWh/capita)', unit: 'kWh per capita' },
  { id: 'EN.ATM.CO2E.PC',     label: 'CO2 emissions (metric tons per capita)',  unit: 't CO2/capita' },
  { id: 'SI.POV.GINI',        label: 'Gini index (income inequality)',          unit: 'gini' },
  { id: 'SL.UEM.TOTL.ZS',     label: 'Unemployment, total (% of labor force)',  unit: '%' },
  { id: 'FP.CPI.TOTL.ZG',     label: 'Inflation, consumer prices (annual %)',   unit: '%' },
  { id: 'SP.DYN.LE00.IN',     label: 'Life expectancy at birth (years)',        unit: 'years' },
  { id: 'SH.STA.SUIC.P5',     label: 'Suicide mortality rate (per 100k)',       unit: 'per 100k' },
  { id: 'VC.IHR.PSRC.P5',     label: 'Intentional homicides (per 100k people)', unit: 'per 100k' },
  { id: 'SM.POP.REFG',        label: 'Refugee population by country of asylum', unit: 'people' },
  { id: 'EG.IMP.CONS.ZS',     label: 'Energy imports, net (% of energy use)',   unit: '%' },
  { id: 'NY.GDP.MKTP.KD.ZG',  label: 'GDP growth (annual %)',                  unit: '%' },
  { id: 'SP.DYN.LE00.IN',     label: 'Life expectancy at birth (years)',        unit: 'years' },
  { id: 'SP.POP.GROW',        label: 'Population growth (annual %)',            unit: '%' },
  { id: 'SM.POP.NETM',        label: 'Net migration',                           unit: 'people' },
  { id: 'IT.NET.USER.ZS',     label: 'Internet users (% of population)',        unit: '%' },
  { id: 'GC.DOD.TOTL.GD.ZS',  label: 'Central government debt (% of GDP)',     unit: '% of GDP' },
  { id: 'EG.FEC.RNEW.ZS',    label: 'Renewable energy consumption (%)',         unit: '%' },
];

async function fetchOne(iso3, indicator, years) {
  // World Bank: https://api.worldbank.org/v2/country/IRN/indicator/NY.GDP.MKTP.CD?date=2014:2023&format=json
  const url = `https://api.worldbank.org/v2/country/${iso3}/indicator/${indicator}?date=${years[0]}:${years[years.length-1]}&format=json&per_page=200`;
  const json = await fetchJson(url);
  if (!Array.isArray(json) || !Array.isArray(json[1])) return null;
  // API returns newest-first; reverse so values align with ascending years.
  const byYear = {};
  for (const row of json[1]) {
    if (row.value != null) byYear[row.date] = row.value;
  }
  return years.map(y => byYear[String(y)] ?? null);
}

async function fetch(query) {
  const indicator = (CATALOG.find(c => c.id === query.indicator) || CATALOG[0]);
  const countries = (query.countries || []).slice(0, 6);
  const years     = query.years && query.years.length ? query.years : pickRecentYears(10);
  if (!countries.length) throw new Error('worldbank: no countries provided');

  const series = [];
  for (const c of countries) {
    const iso3 = toIso3(c);
    if (!iso3) continue;
    try {
      const values = await fetchOne(iso3, indicator.id, years);
      if (values && values.some(v => v != null)) {
        series.push({ name: c, values });
      }
    } catch (_) { /* skip country */ }
  }
  if (!series.length) throw new Error('worldbank: no data for any country');
  return {
    labels:     years.map(String),
    series,
    unit:       indicator.unit,
    source_url: `https://data.worldbank.org/indicator/${indicator.id}`,
  };
}

module.exports = {
  name: 'worldbank',
  label: 'World Bank Open Data',
  description: 'Country-level macro indicators (GDP, trade, population, military spend, energy, homicides, etc).',
  needsKey: [],
  catalog: CATALOG,
  fetch,
};
