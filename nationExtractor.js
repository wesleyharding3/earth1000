/**
 * nationExtractor.js
 *
 * Strict country/ISO extraction from short text (thread/timeline title +
 * description). Only flags a country when it is *explicitly* mentioned:
 *   - canonical country name (United States, Iran, Türkiye)
 *   - well-known alias (US / U.S. / America, UK / Britain, S. Korea, UAE…)
 *   - demonym (American, Iranian, Turkish…)
 *   - city name from the cities table (mapped to its parent country)
 *
 * Used by:
 *   - /api/admin/backfill-nations  (server.js)
 *   - scripts/auditThreadNations.js (CLI)
 *
 * Designed for short text only. Do NOT run on long article bodies — false
 * positives explode at length. The whole point of this module is to keep
 * primary_nations tight: the countries the *thread* is actually about.
 *
 * Ambiguity guards: country names that collide with US states, common given
 * names, or English words (Georgia, Jordan, Chad, Niger, Mali, Turkey) are
 * suppressed unless a disambiguator is present (capital city, demonym,
 * "Republic of …", regional context, etc.). Without this guard a thread
 * about "Georgia governor's race" would attach the country GE to its card.
 */

'use strict';

// ─── Curated country aliases (text → ISO 3166-1 alpha-2) ─────────────────────
// Names we want to recognise that may not appear verbatim in the countries
// table (e.g. "Türkiye" is now the canonical UN name; "America" is colloquial;
// "DPRK" is an acronym). Lowercase keys, ISO-2 values.
const COUNTRY_ALIASES = {
  'u.s.':                'US',
  'u.s.a.':              'US',
  'usa':                 'US',
  'us':                  'US',
  'america':             'US',
  'united states':       'US',
  'united states of america': 'US',

  'u.k.':                'GB',
  'uk':                  'GB',
  'britain':             'GB',
  'great britain':       'GB',
  'united kingdom':      'GB',

  'uae':                 'AE',
  'u.a.e.':              'AE',
  'emirates':            'AE',

  'türkiye':             'TR',
  'turkiye':             'TR',
  'turkey':              'TR',

  'n. korea':            'KP',
  'n korea':             'KP',
  'dprk':                'KP',
  'north korea':         'KP',

  's. korea':            'KR',
  's korea':             'KR',
  'rok':                 'KR',
  'south korea':         'KR',

  'burma':               'MM',
  'myanmar':             'MM',

  'czechia':             'CZ',
  'czech republic':      'CZ',

  'ivory coast':         'CI',
  "côte d'ivoire":       'CI',
  'cote d ivoire':       'CI',

  'vatican':             'VA',
  'vatican city':        'VA',
  'holy see':            'VA',

  'palestine':           'PS',
  'palestinian':         'PS',
  'palestinian territories': 'PS',
  'gaza':                'PS',
  'west bank':           'PS',

  'taiwan':              'TW',
  'republic of china':   'TW',

  'saudi':               'SA',
  'saudi arabia':        'SA',

  'russia':              'RU',
  'russian federation':  'RU',

  'china':               'CN',
  'prc':                 'CN',
  "people's republic of china": 'CN',
  'mainland china':      'CN',

  'eu':                  'EU',
  'european union':      'EU',

  // Disambiguators for the ambiguous-name guard. These force-resolve the
  // ambiguous word to its country meaning when the explicit phrase is used.
  'republic of georgia': 'GE',
  'georgia (country)':   'GE',
  'kingdom of jordan':   'JO',
  'hashemite kingdom':   'JO',
  'republic of chad':    'TD',
  'republic of niger':   'NE',
  'republic of mali':    'ML',
};

// ─── Demonyms (adjective/noun → ISO) ─────────────────────────────────────────
// Adapted from enrichImageLocations.js but keyed by ISO instead of name so we
// don't need a second name→ISO lookup. Single-word, lowercase.
const DEMONYMS = {
  afghan:'AF', albanian:'AL', algerian:'DZ',
  american:'US', angolan:'AO', argentinian:'AR', argentine:'AR',
  armenian:'AM', australian:'AU', austrian:'AT', azerbaijani:'AZ',
  bahraini:'BH', bangladeshi:'BD', belarusian:'BY', belgian:'BE',
  belizean:'BZ', beninese:'BJ', bhutanese:'BT', bolivian:'BO',
  bosnian:'BA', botswanan:'BW', brazilian:'BR', british:'GB',
  bruneian:'BN', bulgarian:'BG', burkinabe:'BF', burundian:'BI', burmese:'MM',
  cambodian:'KH', cameroonian:'CM', canadian:'CA',
  chadian:'TD', chilean:'CL', chinese:'CN',
  colombian:'CO', congolese:'CD', croatian:'HR',
  cuban:'CU', cypriot:'CY', czech:'CZ',
  danish:'DK', djiboutian:'DJ', dominican:'DO', dutch:'NL',
  ecuadorian:'EC', egyptian:'EG', emirati:'AE', eritrean:'ER',
  estonian:'EE', ethiopian:'ET',
  fijian:'FJ', filipino:'PH', finnish:'FI', french:'FR',
  gabonese:'GA', gambian:'GM', georgian:'GE',
  german:'DE', ghanaian:'GH', greek:'GR',
  guatemalan:'GT', guinean:'GN',
  haitian:'HT', honduran:'HN', hungarian:'HU',
  icelandic:'IS', indian:'IN', indonesian:'ID',
  iranian:'IR', iraqi:'IQ', irish:'IE',
  israeli:'IL', italian:'IT', ivorian:'CI',
  jamaican:'JM', japanese:'JP', jordanian:'JO',
  kazakh:'KZ', kenyan:'KE', korean:'KR',
  kuwaiti:'KW', kyrgyz:'KG',
  lao:'LA', laotian:'LA', latvian:'LV', lebanese:'LB',
  liberian:'LR', libyan:'LY', lithuanian:'LT',
  macedonian:'MK', malagasy:'MG', malawian:'MW', malaysian:'MY',
  maldivian:'MV', malian:'ML', maltese:'MT', mauritanian:'MR',
  mauritian:'MU', mexican:'MX', moldovan:'MD',
  mongolian:'MN', montenegrin:'ME', moroccan:'MA', mozambican:'MZ',
  namibian:'NA', nepali:'NP', nepalese:'NP',
  nicaraguan:'NI', nigerien:'NE', nigerian:'NG', norwegian:'NO',
  omani:'OM',
  pakistani:'PK', palestinian:'PS', panamanian:'PA',
  paraguayan:'PY', peruvian:'PE', philippine:'PH',
  polish:'PL', portuguese:'PT',
  qatari:'QA',
  romanian:'RO', russian:'RU', rwandan:'RW',
  salvadoran:'SV', samoan:'WS', saudi:'SA',
  senegalese:'SN', serbian:'RS', singaporean:'SG',
  slovak:'SK', slovenian:'SI', somali:'SO',
  spanish:'ES', sudanese:'SD', surinamese:'SR',
  swedish:'SE', swiss:'CH', syrian:'SY',
  taiwanese:'TW', tajik:'TJ', tanzanian:'TZ',
  thai:'TH', togolese:'TG', tunisian:'TN',
  turkish:'TR', turkmen:'TM',
  ugandan:'UG', ukrainian:'UA', uruguayan:'UY', uzbek:'UZ',
  venezuelan:'VE', vietnamese:'VN',
  yemeni:'YE',
  zambian:'ZM', zimbabwean:'ZW',
};

// ─── Ambiguous country names that need a disambiguator ───────────────────────
// These ISO codes will only be admitted if the text *also* contains one of
// the listed disambiguator tokens (case-insensitive substring). Otherwise the
// raw match (e.g. "Georgia") is dropped because the word probably refers to a
// US state, a person's name, an English word, etc.
//
// The disambiguator can be: the demonym, the capital city, a regional context
// phrase, or an explicit "Republic of …" form. Anything in COUNTRY_ALIASES
// that maps to the same ISO will also count as a disambiguator (handled in
// extractNations).
const AMBIGUOUS_DISAMBIGUATORS = {
  GE: ['georgian', 'tbilisi', 'caucasus', 'south ossetia', 'abkhazia', 'saakashvili',
       'republic of georgia', 'georgia (country)'],
  JO: ['jordanian', 'amman', 'king abdullah', 'middle east', 'levant',
       'kingdom of jordan', 'hashemite kingdom'],
  TD: ['chadian', "n'djamena", 'ndjamena', 'sahel', 'lake chad',
       'republic of chad'],
  NE: ['nigerien', 'niamey', 'sahel', 'republic of niger'],
  ML: ['malian', 'bamako', 'sahel', 'timbuktu', 'republic of mali'],
};

// US-state context tokens that, if present, suppress the country GE
// (Georgia) when the only match was the bare word "georgia". These are
// strong indicators the headline is about the US state of Georgia, not the
// country in the Caucasus.
const US_STATE_GEORGIA_HINTS = [
  'atlanta', 'savannah', 'augusta', 'fulton county',
  'kemp', 'stacey abrams', 'raphael warnock', 'jon ossoff',
  'governor kemp', 'state of georgia',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _norm(text) {
  return (text || '').toLowerCase();
}

// Word-boundary check: the chars immediately before/after the match must NOT
// be alphanumeric, otherwise we matched a fragment of a longer word
// (e.g. "iran" inside "iranian", "us" inside "russia").
function _isWordBoundaryMatch(text, idx, len) {
  const before = idx > 0 ? text[idx - 1] : ' ';
  const after  = idx + len < text.length ? text[idx + len] : ' ';
  // Treat letters AND digits as "word chars" so we don't match "us" inside
  // "us2024". Apostrophes count as part of the word too (don't break "n'djamena").
  const isWord = (c) => /[a-z0-9']/i.test(c);
  return !isWord(before) && !isWord(after);
}

// Find every word-boundary occurrence of `needle` in lowercased `haystack`.
function _findAll(haystack, needle) {
  const out = [];
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    if (_isWordBoundaryMatch(haystack, idx, needle.length)) out.push(idx);
    i = idx + needle.length;
  }
  return out;
}

// ─── Public: build a gazetteer once, then call extractNations many times ─────

/**
 * loadGazetteer(pool) → { aliases: Map<lowerName, ISO>, sortedNames: string[] }
 *
 * Pulls country names from the `countries` table and city names from the
 * `cities` table (active cities only), merges them with the curated alias and
 * demonym maps, and returns a pre-sorted lookup ready for extractNations().
 *
 * Sort order: longest first, so "South Korea" matches before "Korea" and
 * "United Arab Emirates" before "Arab".
 */
async function loadGazetteer(pool) {
  const { rows: countries } = await pool.query(`
    SELECT name, iso_code FROM countries WHERE iso_code IS NOT NULL
  `);
  const { rows: cities } = await pool.query(`
    SELECT ci.name AS city_name, co.iso_code
    FROM cities ci
    JOIN countries co ON co.id = ci.country_id
    WHERE ci.is_active = true AND co.iso_code IS NOT NULL
  `);

  const aliases = new Map();

  // Country names from the DB (canonical).
  for (const c of countries) {
    const name = (c.name || '').trim().toLowerCase();
    if (name.length >= 3) aliases.set(name, c.iso_code.toUpperCase());
  }

  // Curated aliases override / supplement the DB names.
  for (const [name, iso] of Object.entries(COUNTRY_ALIASES)) {
    aliases.set(name, iso);
  }

  // Demonyms (single-word adjectives / nouns).
  for (const [demonym, iso] of Object.entries(DEMONYMS)) {
    aliases.set(demonym, iso);
  }

  // Cities last — never overwrite a country/alias/demonym match.
  for (const ci of cities) {
    const name = (ci.city_name || '').trim().toLowerCase();
    if (name.length < 4) continue;            // skip "Ur", "Aix", etc.
    if (aliases.has(name)) continue;          // country/demonym wins
    aliases.set(name, ci.iso_code.toUpperCase());
  }

  const sortedNames = [...aliases.keys()].sort((a, b) => b.length - a.length);
  return { aliases, sortedNames };
}

/**
 * extractNations(text, gazetteer) → string[] (sorted ISO codes)
 *
 * Returns the unique ISO-2 codes mentioned in `text`, applying word-boundary
 * matching and the ambiguity guard (Georgia/Jordan/Chad/Niger/Mali). The
 * input is expected to be short (a thread title + description, ~50–500 chars).
 *
 * The returned array is sorted alphabetically so DB updates are stable.
 */
function extractNations(text, gazetteer) {
  if (!text) return [];
  const lc = _norm(text);
  if (!lc.trim()) return [];

  // Phase 1: find every match (longest patterns first so subsumed shorter
  // patterns get skipped via the `consumed` ranges).
  const consumed = []; // [start, end) ranges already claimed by a longer match
  const matched  = new Set();   // ISO codes we've seen
  const evidence = new Map();   // ISO → array of matched surface forms

  for (const name of gazetteer.sortedNames) {
    const occs = _findAll(lc, name);
    if (!occs.length) continue;

    for (const idx of occs) {
      const end = idx + name.length;
      // Skip if this range is fully inside a previous (longer) match.
      let inside = false;
      for (const [s, e] of consumed) {
        if (idx >= s && end <= e) { inside = true; break; }
      }
      if (inside) continue;
      consumed.push([idx, end]);

      const iso = gazetteer.aliases.get(name);
      matched.add(iso);
      if (!evidence.has(iso)) evidence.set(iso, []);
      evidence.get(iso).push(name);
    }
  }

  // Phase 2: ambiguity guard. For each ISO in the ambiguous list, drop it
  // unless we have a strong disambiguator in the text or in the surface
  // forms we already matched for that ISO.
  for (const [iso, hints] of Object.entries(AMBIGUOUS_DISAMBIGUATORS)) {
    if (!matched.has(iso)) continue;

    const surfaces = evidence.get(iso) || [];
    // If any non-bare-name surface form was matched, keep it. Bare names are
    // the country's plain name as it appears in the DB ("georgia", "jordan"…).
    const bareNames = new Set();
    for (const [name, code] of gazetteer.aliases.entries()) {
      if (code === iso && !DEMONYMS[name] && !COUNTRY_ALIASES[name]) {
        bareNames.add(name);
      }
    }
    const hasNonBareEvidence = surfaces.some(s => !bareNames.has(s));
    if (hasNonBareEvidence) continue;   // demonym, alias or city → keep

    // Otherwise we need a disambiguator hint somewhere in the raw text.
    const hasHint = hints.some(h => lc.includes(h));
    if (!hasHint) matched.delete(iso);
  }

  // Phase 3: special-case Georgia-the-state. If we ended up with GE but the
  // text is clearly about US-state Georgia, drop it.
  if (matched.has('GE')) {
    const surfaces = evidence.get('GE') || [];
    const onlyBare = surfaces.every(s => s === 'georgia');
    if (onlyBare && US_STATE_GEORGIA_HINTS.some(h => lc.includes(h))) {
      matched.delete('GE');
    }
  }

  return [...matched].sort();
}

module.exports = {
  loadGazetteer,
  extractNations,
  // exported for tests / debugging
  COUNTRY_ALIASES,
  DEMONYMS,
  AMBIGUOUS_DISAMBIGUATORS,
};
