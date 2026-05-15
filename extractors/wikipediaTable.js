/**
 * wikipediaTable.js — extract per-country values from a Wikipedia
 * "List of countries by X" article. Single most valuable extractor:
 * one parser covers hundreds of geographic / demographic / cultural
 * ranking pages.
 *
 * Input spec (from Claude tool-use call):
 *   url               — full Wikipedia article URL
 *   table_selector    — CSS selector OR "wikitable[N]" (0-indexed)
 *                       to pick a specific table; default = first .wikitable
 *   country_column    — header text (case-insensitive substring) for the
 *                       country/state column
 *   value_columns     — array of header texts; each column's numeric
 *                       value is extracted per row. Most queries use one.
 *   derived           — optional { name: string, expr: 'a - b' | 'a + b' |
 *                       'a / b' | 'a * b' } combining value_columns by
 *                       position. e.g. for elevation range: value_columns
 *                       = ["Highest", "Lowest"], derived = { expr: "a - b" }.
 *
 * Returns:
 *   { values: [{ iso, value, source_row_country }], skipped: [...],
 *     source_note, table_used, error? }
 *
 * Caches the fetched HTML in extracted_source_cache (24h TTL) so the
 * same source URL doesn't re-hit Wikipedia per query.
 */

'use strict';

const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Earth00MapThis/1.0 (https://earth00.com; contact@earth00.com) Cheerio';
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;

// In-memory cache for the HTML of fetched URLs. Process-local — when
// the cron / web server restarts, the cache resets. Postgres-backed
// cache is in heatmap_qa_cache for the FULL resolved heatmap result;
// this is just to avoid re-fetching the same Wikipedia page when two
// adjacent queries reference it.
const _htmlCache = new Map();   // url → { html, fetchedAt }

async function _fetchHtml(url) {
  const cached = _htmlCache.get(url);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return { html: cached.html, fromCache: true };
  }
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) throw new Error(`Wikipedia fetch failed: HTTP ${res.status} for ${url}`);
  const html = await res.text();
  _htmlCache.set(url, { html, fetchedAt: Date.now() });
  // Cap in-memory cache size — drop oldest if growing past 50 entries
  if (_htmlCache.size > 50) {
    const first = _htmlCache.keys().next().value;
    _htmlCache.delete(first);
  }
  return { html, fromCache: false };
}

// Pick the table from the parsed page based on selector.
//   "wikitable[N]" → Nth element with class .wikitable (0-indexed)
//   any other string → CSS selector
//   missing → first .wikitable on the page
function _pickTable($, selector) {
  if (!selector) {
    const t = $('table.wikitable').first();
    if (!t.length) throw new Error('No .wikitable found on page');
    return t;
  }
  const indexedMatch = selector.match(/^wikitable\[(\d+)\]$/i);
  if (indexedMatch) {
    const idx = parseInt(indexedMatch[1], 10);
    const all = $('table.wikitable');
    if (idx >= all.length) throw new Error(`wikitable[${idx}] requested but only ${all.length} found`);
    return all.eq(idx);
  }
  const sel = $(selector);
  if (!sel.length) throw new Error(`Selector "${selector}" matched no element`);
  return sel.first();
}

// Build a map of header text → column index from the table's <th> row.
function _buildHeaderMap($, $table) {
  // Prefer thead headers; fall back to the first row's th cells.
  const headerCells = $table.find('thead tr').first().find('th').length
    ? $table.find('thead tr').first().find('th')
    : $table.find('tr').first().find('th');
  const map = new Map();   // normalized text → index
  headerCells.each((i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (text) map.set(text, i);
  });
  return map;
}

// Find a column index by header text. Case-insensitive; matches if the
// header CONTAINS the target string (so "Highest point (m)" matches
// "highest"). Returns -1 if not found.
function _findCol(headerMap, target) {
  if (!target) return -1;
  const t = String(target).trim().toLowerCase();
  if (headerMap.has(t)) return headerMap.get(t);
  for (const [k, v] of headerMap) {
    if (k.includes(t) || t.includes(k)) return v;
  }
  return -1;
}

// Extract a numeric value from a cell. Handles:
//   "1,234.5"     → 1234.5
//   "−1,234.5"    → -1234.5 (Unicode minus)
//   "4,810 m"     → 4810
//   "4,810 (Mont Blanc)"        → 4810   (first numeric token wins)
//   "8,848.86[1]" → 8848.86    (footnote stripped)
//   "−420 (Dead Sea)"           → -420
//   "—" or "N/A" or "n.d."      → null
// Returns a Number or null.
function _parseNumericCell(cellText) {
  if (cellText == null) return null;
  let s = String(cellText)
    .replace(/\[[^\]]*\]/g, '')              // strip footnote markers
    .replace(/\([^)]*\)/g, '')               // strip parentheticals
    .replace(/[−–—]/g, '-')   // unicode minuses → ASCII
    .replace(/[ \s]+/g, ' ')            // collapse whitespace incl. nbsp
    .trim();
  if (!s) return null;
  // Find first signed-numeric token
  const m = s.match(/-?[0-9][0-9,]*(?:\.[0-9]+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Read the country name from the row — usually the first cell (a <td>
// or <th>). If country_column is specified, use that header's column.
function _readCountryName($, $row, countryColIdx) {
  const cells = $row.find('td, th');
  let cell;
  if (countryColIdx >= 0 && countryColIdx < cells.length) {
    cell = cells.eq(countryColIdx);
  } else {
    // Fallback: pick the first cell whose contents include alpha text
    // (Wikipedia ranks sometimes put a rank-number in column 0)
    cells.each((i, el) => {
      const txt = $(el).text().trim();
      if (!cell && /[a-zA-Z]/.test(txt)) cell = $(el);
    });
    if (!cell) cell = cells.eq(0);
  }
  // Use the link text if present (e.g. "<a>France</a>"), else cell text
  let name = '';
  const a = cell.find('a').first();
  if (a.length) name = a.text();
  if (!name) name = cell.text();
  return name.replace(/\s+/g, ' ').trim();
}

// Apply a derived expression to the per-row numeric columns.
// Supported: "a - b", "a + b", "a / b", "a * b" where a, b, c, ...
// refer to value_columns[0], [1], [2], ... by position.
function _applyDerived(values, expr) {
  if (!expr || values.length === 0) return values[0] ?? null;
  const e = String(expr).toLowerCase().replace(/\s+/g, '');
  const m = e.match(/^([a-z])([\-+*\/])([a-z])$/);
  if (!m) return values[0] ?? null;
  const a = values[m[1].charCodeAt(0) - 97];
  const b = values[m[3].charCodeAt(0) - 97];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  switch (m[2]) {
    case '-': return a - b;
    case '+': return a + b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    default: return null;
  }
}

/**
 * Tool definition for Claude. Registered in extractors/index.js.
 */
const toolDef = {
  name: 'extract_wikipedia_table',
  description:
    'Extract per-country values from a Wikipedia "List of countries by X" article. Use for: ' +
    'geography (elevation, area, coastline, terrain), demographics (when WB lacks the metric), ' +
    'cultural / linguistic data (languages, religions, alphabets), rankings of named entities ' +
    '(peaks, rivers, museums, capitals), and any cross-country comparison Wikipedia maintains a ' +
    'dedicated list page for. Always prefer this when the question maps to a known Wikipedia list. ' +
    'IMPORTANT: only call this with a URL you are confident exists — the canonical pattern is ' +
    '"https://en.wikipedia.org/wiki/List_of_countries_by_<feature>".',
  input_schema: {
    type: 'object',
    required: ['url', 'country_column', 'value_columns'],
    properties: {
      url: {
        type: 'string',
        description: 'Full https://en.wikipedia.org/wiki/... URL of the article.',
      },
      table_selector: {
        type: 'string',
        description: 'Optional. "wikitable[N]" (0-indexed) when the page has multiple .wikitable tables and you want a specific one. Default: first .wikitable.',
      },
      country_column: {
        type: 'string',
        description: 'Header text (case-insensitive substring) of the column that names each country. Common values: "Country", "Country/Territory", "State", "Nation".',
      },
      value_columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of header-text substrings for the numeric column(s) to extract per row. Use 1 column for direct values; 2+ for derived expressions like "high - low".',
      },
      derived: {
        type: 'object',
        description: 'Optional. Combine value_columns into a single per-country value. Example for elevation range: { expr: "a - b" } with value_columns = ["Highest point", "Lowest point"] yields high minus low.',
        properties: {
          expr: { type: 'string', description: 'Expression in single letters: a, b, c, ... referencing value_columns[0], [1], [2], ... Operators: + - * /. e.g. "a - b".' },
        },
      },
    },
  },
};

/**
 * Run the extraction. Called by the heatmapResolver's tool-execution
 * loop when Claude calls extract_wikipedia_table.
 *
 * @param {object} spec — matches toolDef.input_schema
 * @param {function} resolveName — name → ISO from _isoMatch.loadResolver
 */
async function run(spec, resolveName) {
  const { url, table_selector, country_column, value_columns, derived } = spec;
  if (!url || !/^https?:\/\/(?:[a-z]{2,3}\.)?wikipedia\.org\/wiki\//.test(url)) {
    return { error: `extract_wikipedia_table: invalid url (${url}). Expected a https://*.wikipedia.org/wiki/... URL.` };
  }
  if (!Array.isArray(value_columns) || value_columns.length === 0) {
    return { error: 'extract_wikipedia_table: value_columns must be a non-empty array' };
  }

  let html, fromCache;
  try {
    ({ html, fromCache } = await _fetchHtml(url));
  } catch (err) {
    return { error: `Wikipedia fetch failed: ${err.message}` };
  }

  const $ = cheerio.load(html);
  let $table;
  try {
    $table = _pickTable($, table_selector);
  } catch (err) {
    return { error: err.message };
  }

  const headerMap = _buildHeaderMap($, $table);
  if (headerMap.size === 0) {
    return { error: 'Table has no recognisable <th> header row' };
  }
  const countryColIdx = _findCol(headerMap, country_column);
  const valueColIdxs = value_columns.map(c => _findCol(headerMap, c));
  const missing = value_columns.filter((c, i) => valueColIdxs[i] === -1);
  if (missing.length) {
    return {
      error: `Value columns not found in header: ${missing.join(', ')}. ` +
             `Available headers: ${[...headerMap.keys()].join(' | ')}`,
    };
  }

  const values = [];
  const skipped = [];
  const rows = $table.find('tbody tr').length
    ? $table.find('tbody tr')
    : $table.find('tr').slice(1);   // skip header row when no tbody

  rows.each((rowIdx, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td, th');
    if (cells.length < Math.max(countryColIdx + 1, ...valueColIdxs.map(i => i + 1))) {
      return;   // sparse / colspanned row — skip
    }
    const name = _readCountryName($, $row, countryColIdx);
    if (!name) { skipped.push({ rowIdx, reason: 'no country name' }); return; }

    const colValues = valueColIdxs.map(idx => _parseNumericCell($(cells.get(idx)).text()));
    if (colValues.some(v => v == null)) {
      skipped.push({ rowIdx, name, reason: 'null numeric' });
      return;
    }
    const value = derived ? _applyDerived(colValues, derived.expr) : colValues[0];
    if (value == null || !Number.isFinite(value)) {
      skipped.push({ rowIdx, name, reason: 'derived computation null' });
      return;
    }
    const iso = resolveName(name);
    if (!iso) { skipped.push({ rowIdx, name, reason: 'unresolved country name' }); return; }
    values.push({ iso, value, source_row_country: name });
  });

  // Deduplicate by ISO, keeping first occurrence (Wikipedia tables
  // occasionally list disputed territories under multiple countries)
  const dedup = [];
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v.iso)) continue;
    seen.add(v.iso);
    dedup.push(v);
  }

  return {
    values: dedup,
    skipped: skipped.slice(0, 25),  // cap log size returned to Claude
    skipped_count: skipped.length,
    source_note: `Wikipedia (${new URL(url).pathname.split('/').pop().replace(/_/g, ' ')}) — extracted ${new Date().toISOString().slice(0, 10)}${fromCache ? ' (cached)' : ''}`,
    table_used: table_selector || 'wikitable[0]',
    row_count: dedup.length,
  };
}

module.exports = { toolDef, run };
