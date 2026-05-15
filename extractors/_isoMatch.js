/**
 * _isoMatch.js — shared name → ISO 3166-1 alpha-2 resolver for all
 * Map-This extractors.
 *
 * Each parser receives country names in the source's preferred form
 * ("United Kingdom" / "Czech Republic" / "Côte d'Ivoire" / "United
 * States of America") and needs to map those to the canonical alpha-2
 * codes the heatmap renderer expects (GB / CZ / CI / US).
 *
 * Strategy (in order of precedence per name):
 *   1. Direct match against the project's `countries` table (DB-backed).
 *   2. Match against a small alias table covering forms the DB names
 *      table doesn't carry verbatim ("USA" / "Czech Republic" / etc.).
 *   3. Normalized lowercase + punctuation-stripped match against (1)+(2).
 *   4. Substring-prefix match for "Bahamas, The" / "Korea, Republic of"
 *      style ordering quirks.
 *
 * Returns null when no confident match — never invents an ISO code.
 *
 * The resolver caches the DB lookup so per-extraction calls amortize
 * to ~O(1) after the first call. Build once at module load via
 * loadResolver(pool) and reuse the returned function across many
 * extractions.
 */

'use strict';

const { normalizeIso } = require('../isoCountryCodes');

// Aliases for forms the `countries.name` column doesn't include verbatim.
// Keep this list tight — it's last-resort, after the DB lookup. Add
// entries when a real query fails, not preemptively.
const ALIASES = {
  // Anglosphere variants
  'usa':                     'US',
  'u.s.':                    'US',
  'u.s.a.':                  'US',
  'united states':           'US',
  'united states of america':'US',
  'america':                 'US',
  'uk':                      'GB',
  'u.k.':                    'GB',
  'britain':                 'GB',
  'great britain':           'GB',
  'united kingdom':          'GB',
  'england':                 'GB',           // controversial but practical — Wikipedia's "List of countries" pages occasionally use "England" for UK rows
  // East Asia
  'south korea':             'KR',
  'korea, south':            'KR',
  'korea (south)':           'KR',
  'republic of korea':       'KR',
  'north korea':             'KP',
  'korea, north':            'KP',
  'korea (north)':           'KP',
  'dprk':                    'KP',
  'democratic peoples republic of korea': 'KP',
  // Middle East
  'uae':                     'AE',
  'emirates':                'AE',
  'united arab emirates':    'AE',
  // Czechia variants
  'czech republic':          'CZ',
  'czechia':                 'CZ',
  // Burma / Myanmar
  'burma':                   'MM',
  'myanmar (burma)':         'MM',
  // East Timor
  'timor-leste':             'TL',
  'east timor':              'TL',
  // Congo
  'congo':                   'CG',         // Republic of the Congo (smaller, brazzaville)
  'republic of the congo':   'CG',
  'congo, republic of the':  'CG',
  'dr congo':                'CD',
  'democratic republic of the congo': 'CD',
  'congo, democratic republic of the': 'CD',
  'drc':                     'CD',
  'zaire':                   'CD',
  // Cape Verde
  'cape verde':              'CV',
  'cabo verde':              'CV',
  // Macedonia / North Macedonia
  'macedonia':               'MK',
  'north macedonia':         'MK',
  'fyr macedonia':           'MK',
  'republic of macedonia':   'MK',
  // Ivory Coast
  'ivory coast':             'CI',
  "côte d'ivoire":           'CI',
  "cote d'ivoire":           'CI',
  // Swaziland / Eswatini
  'swaziland':               'SZ',
  'eswatini':                'SZ',
  // Vatican / Holy See
  'vatican':                 'VA',
  'vatican city':            'VA',
  'holy see':                'VA',
  // Russia
  'russia':                  'RU',
  'russian federation':      'RU',
  // China / Taiwan
  'china':                   'CN',
  'mainland china':          'CN',
  'people\'s republic of china': 'CN',
  'taiwan':                  'TW',
  'republic of china':       'TW',          // Taiwan
  'chinese taipei':          'TW',
  // Hong Kong / Macao — kept as separate territories per ISO 3166-1
  'hong kong':               'HK',
  'macao':                   'MO',
  'macau':                   'MO',
  // Palestine
  'palestine':               'PS',
  'palestinian territories': 'PS',
  'state of palestine':      'PS',
  'west bank':               'PS',
  'gaza':                    'PS',
  // Other common parenthetical forms
  'bahamas':                 'BS',
  'the bahamas':             'BS',
  'gambia':                  'GM',
  'the gambia':              'GM',
  'syria':                   'SY',
  'syrian arab republic':    'SY',
  'iran':                    'IR',
  'islamic republic of iran':'IR',
  'laos':                    'LA',
  'lao pdr':                 'LA',
  'vietnam':                 'VN',
  'viet nam':                'VN',
  'venezuela':               'VE',
  'bolivia':                 'BO',
  'tanzania':                'TZ',
  'moldova':                 'MD',
  'micronesia':              'FM',
  'federated states of micronesia': 'FM',
};

function _normalize(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // strip parentheticals
    .replace(/\[[^\]]*\]/g, ' ')         // strip square-bracket footnote markers
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9'\- ]+/g, ' ')     // strip non-letter except ' and -
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a resolver function backed by the project's `countries` table.
 * Call once at module load; reuse the returned function for every
 * extractor's row mapping.
 *
 * @param {Pool} pool pg pool
 * @returns {(name: string) => string | null}
 */
async function loadResolver(pool) {
  const { rows } = await pool.query(
    `SELECT iso_code, name
       FROM countries
      WHERE iso_code IS NOT NULL AND length(iso_code) = 2`
  );
  const byNormName = new Map();
  for (const r of rows) {
    const iso = String(r.iso_code).toUpperCase();
    const norm = _normalize(r.name);
    if (norm) byNormName.set(norm, iso);
  }
  // Layer aliases on top — alias wins ONLY when not already in DB names.
  for (const [k, v] of Object.entries(ALIASES)) {
    const norm = _normalize(k);
    if (!byNormName.has(norm)) byNormName.set(norm, v);
  }

  return function resolveName(name) {
    if (!name) return null;
    // 0) If the caller passed an ISO directly, normalize it. Some
    //    extractors (World Bank API) return ISO codes natively.
    const directIso = normalizeIso(name);
    if (directIso) return directIso;

    const norm = _normalize(name);
    if (!norm) return null;

    // 1) Exact normalized name
    const hit = byNormName.get(norm);
    if (hit) return hit;

    // 2) "Bahamas, The" / "Korea, Republic of" — strip after comma
    const beforeComma = norm.split(',')[0].trim();
    if (beforeComma && beforeComma !== norm) {
      const hit2 = byNormName.get(beforeComma);
      if (hit2) return hit2;
    }

    // 3) "Republic of Korea" → "Korea" — strip leading "Republic of"
    const stripped = norm
      .replace(/^(?:republic|kingdom|state|people'?s republic|democratic republic|federal republic|islamic republic|federated states) of /i, '')
      .trim();
    if (stripped && stripped !== norm) {
      const hit3 = byNormName.get(stripped);
      if (hit3) return hit3;
    }

    // 4) Prefix substring on full names (last resort, costly but bounded)
    for (const [n, iso] of byNormName) {
      if (n.startsWith(norm) || norm.startsWith(n)) {
        // Guard: avoid substring noise like "Niger" matching "Nigeria"
        // by requiring the matched key to be at least 4 chars and the
        // difference to be at most 4 chars.
        if (n.length >= 4 && Math.abs(n.length - norm.length) <= 4) return iso;
      }
    }

    return null;
  };
}

module.exports = { loadResolver };
