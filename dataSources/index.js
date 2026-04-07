/**
 * dataSources/index.js
 *
 * Registry of real-data adapters used by dataPanelGenerator.
 * Each adapter exports:
 *   name           — short id (matches DB `data_panels.adapter`)
 *   label          — human-readable label for source attribution
 *   needsKey       — env var name(s) it requires; null/empty if free
 *   catalog        — small curated list of indicators Claude can pick from
 *   fetch(query)   — async; returns { labels, series, unit, source_url } or throws
 *
 * Adapters MUST normalize their output to:
 *   {
 *     labels:   ['2018','2019',...],            // x-axis labels
 *     series:   [{ name:'Iran', values:[1,2,3] }, ...],
 *     unit:     'million barrels/day',          // optional
 *     source_url: 'https://...'                 // direct link to the data
 *   }
 */

'use strict';

const worldbank = require('./worldbank');
const owid      = require('./owid');
const gdelt     = require('./gdelt');
const usgs      = require('./usgs');
const noaa      = require('./noaa');
const eia       = require('./eia');
const fred      = require('./fred');
const comtrade  = require('./comtrade');
const acled     = require('./acled');

const ALL = [worldbank, owid, gdelt, usgs, noaa, eia, fred, comtrade, acled];

function isAdapterAvailable(a) {
  if (!a.needsKey || !a.needsKey.length) return true;
  return a.needsKey.every(k => !!process.env[k]);
}

function listAvailable() {
  return ALL.filter(isAdapterAvailable);
}

function getAdapter(name) {
  const a = ALL.find(x => x.name === name);
  if (!a) return null;
  if (!isAdapterAvailable(a)) return null;
  return a;
}

/**
 * Returns a compact JSON-serialisable catalog of all available adapters
 * with their indicator shortlists, to inject into the Claude prompt.
 */
function buildCatalogForPrompt() {
  return listAvailable().map(a => ({
    adapter:      a.name,
    label:        a.label,
    description:  a.description,
    indicators:   a.catalog,
  }));
}

module.exports = {
  ALL,
  listAvailable,
  getAdapter,
  buildCatalogForPrompt,
  isAdapterAvailable,
};
