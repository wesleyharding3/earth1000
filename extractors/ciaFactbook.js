/**
 * ciaFactbook.js — extract a per-country value from the CIA World Factbook.
 *
 * The Factbook publishes a per-country page (e.g. /countries/france/)
 * and a "Field listing" page that lists the values for a single field
 * across every country (e.g. /field/area/, /field/population/,
 * /field/elevation/). The field-listing pages are easier to parse —
 * one HTTP request, all countries.
 *
 * Endpoint pattern:
 *   https://www.cia.gov/the-world-factbook/field/{FIELD_SLUG}/
 *
 * Field slugs are stable, kebab-case. Examples:
 *   area, population, gdp-real-growth-rate, life-expectancy-at-birth,
 *   elevation, military-expenditures-percent-of-gdp, religions,
 *   languages, ethnic-groups, urbanization, median-age.
 *
 * The page has h3 country names followed by a structured value block.
 * Parsing is brittler than Wikipedia tables, so this extractor is a
 * FALLBACK — use World Bank or Wikipedia first when the data lives
 * there.
 *
 * Auth: none, public.
 */

'use strict';

const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Earth00MapThis/1.0 (https://earth00.com)';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _htmlCache = new Map();   // url → { html, fetchedAt }

const toolDef = {
  name: 'query_cia_factbook_field',
  description:
    'Fetch a per-country field listing from the CIA World Factbook. Use as fallback when ' +
    'World Bank lacks the indicator and Wikipedia tables are too varied. Good for: terrain ' +
    'types, government form, military service / conscription status, official languages, ' +
    'religion breakdowns, ethnic-group breakdowns, urbanization rate, median age. ' +
    'Field slugs are kebab-case: "area", "population", "elevation", "life-expectancy-at-birth", ' +
    '"military-expenditures-percent-of-gdp", "religions", "languages". ' +
    'Returns first numeric value parsed from each country\'s entry; for text-heavy fields ' +
    '(languages, religions) the parser returns null and you should pick a different tool.',
  input_schema: {
    type: 'object',
    required: ['field_slug'],
    properties: {
      field_slug: {
        type: 'string',
        description: 'Kebab-case field name as it appears in the Factbook URL. e.g. "area", "population", "life-expectancy-at-birth", "elevation".',
      },
      // Some Factbook fields have multiple numeric sub-fields per country
      // (elevation: highest point, lowest point, mean elevation). The
      // sub_field selector picks one of them by header substring.
      sub_field: {
        type: 'string',
        description: 'Optional substring identifying the sub-field when the entry has multiple values (e.g. "highest point" for elevation). Case-insensitive; first match wins.',
      },
    },
  },
};

async function _fetchHtml(url) {
  const cached = _htmlCache.get(url);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return { html: cached.html, fromCache: true };
  }
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Factbook HTTP ${res.status}`);
    const html = await res.text();
    _htmlCache.set(url, { html, fetchedAt: Date.now() });
    if (_htmlCache.size > 30) {
      const first = _htmlCache.keys().next().value;
      _htmlCache.delete(first);
    }
    return { html, fromCache: false };
  } finally {
    clearTimeout(tid);
  }
}

function _parseNumber(text) {
  if (!text) return null;
  const s = String(text)
    .replace(/[−–—]/g, '-')
    .replace(/[ \s]+/g, ' ')
    .trim();
  const m = s.match(/-?[0-9][0-9,]*(?:\.[0-9]+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function run(spec, resolveName, env = {}) {
  const { field_slug, sub_field } = spec;
  if (!field_slug || typeof field_slug !== 'string') {
    return { error: 'query_cia_factbook_field: field_slug required' };
  }
  const url = `https://www.cia.gov/the-world-factbook/field/${encodeURIComponent(field_slug)}/`;

  let html, fromCache;
  try {
    ({ html, fromCache } = await _fetchHtml(url));
  } catch (err) {
    return { error: `Factbook fetch failed: ${err.message}` };
  }
  const $ = cheerio.load(html);

  // Field-listing pages have a sequence of country sections. Modern
  // Factbook layout: each country is an <article> or has a country
  // name in a header element followed by definition list / paragraph
  // content. The structure changes across redesigns — we use multiple
  // selectors and stop at the first that produces results.
  const countrySections = [];
  // Layout A: <h3 class="country">Name</h3> followed by .field__items
  $('article, section').each((i, el) => {
    const $el = $(el);
    const header = $el.find('h2, h3, h4').first().text().replace(/\s+/g, ' ').trim();
    if (!header || header.length > 80) return;
    countrySections.push({ name: header, html: $el.html() });
  });
  // Layout B: flat <h3> markers interleaved with content (older Factbook
  // print). Walk siblings.
  if (countrySections.length < 50) {
    let cur = null;
    $('h2, h3').each((i, el) => {
      const $el = $(el);
      const name = $el.text().replace(/\s+/g, ' ').trim();
      if (!name || name.length > 80) return;
      if (cur) countrySections.push(cur);
      cur = { name, html: '' };
      // Collect content until next h2/h3
      let $next = $el.next();
      while ($next.length && !$next.is('h2, h3')) {
        cur.html += $.html($next) || '';
        $next = $next.next();
      }
    });
    if (cur) countrySections.push(cur);
  }

  if (countrySections.length < 20) {
    return {
      error: `Factbook page parsed only ${countrySections.length} country sections; page layout may have changed for field "${field_slug}"`,
      url,
    };
  }

  const values = [];
  const skipped = [];

  for (const sec of countrySections) {
    const iso = resolveName(sec.name);
    if (!iso) { skipped.push({ name: sec.name, reason: 'unresolved' }); continue; }

    // Extract text content for value parsing
    const $$ = cheerio.load(`<div>${sec.html || ''}</div>`);
    const text = $$('div').text();

    let value = null;
    if (sub_field) {
      // Find a line matching the sub_field substring, parse value after
      // the colon / dash.
      const subRe = new RegExp(
        `${sub_field.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}[^a-z0-9]*[:\\-]?\\s*([^\\n;]+)`,
        'i'
      );
      const m = text.match(subRe);
      if (m) value = _parseNumber(m[1]);
    } else {
      value = _parseNumber(text);
    }

    if (value == null) {
      skipped.push({ name: sec.name, reason: sub_field ? `no "${sub_field}" sub-value` : 'no numeric value' });
      continue;
    }
    values.push({ iso, value, source_row_country: sec.name });
  }

  // Dedupe
  const dedup = [];
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v.iso)) continue;
    seen.add(v.iso); dedup.push(v);
  }

  return {
    values: dedup,
    skipped: skipped.slice(0, 25),
    skipped_count: skipped.length,
    source_note: `CIA World Factbook — field/${field_slug}${sub_field ? ` (${sub_field})` : ''}${fromCache ? ' (cached)' : ''}`,
    row_count: dedup.length,
  };
}

module.exports = { toolDef, run };
