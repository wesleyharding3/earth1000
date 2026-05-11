'use strict';

/**
 * isoCountryCodes.js — single source of truth for ISO 3166-1 country
 * codes used throughout the backend.
 *
 * What this exists to solve:
 *
 *   1. `primary_nations` / `secondary_nations` arrays in story_threads
 *      and story_timelines occasionally contain alpha-3 codes ("POL",
 *      "RUS", "USA") instead of the alpha-2 codes the rest of the app
 *      assumes. Sources of contamination over time:
 *        - Migrations that bulk-imported alpha-3 from a third-party set
 *        - Claude occasionally returning alpha-3 despite the prompt
 *          asking for alpha-2 ("ISO 3166-1 alpha-2")
 *        - Admin UI tolerating any 2-3 letter code via the old regex
 *          /^[A-Z]{2,3}$/
 *      Visible symptom: chips render with the iso-code text but no
 *      flag, because flagcdn.com only serves alpha-2 (pl.png, not
 *      pol.png). The chip's onerror falls back to text — user sees
 *      "POL" without realizing it's the wrong code.
 *
 *   2. Garbage codes can also slip in from hallucination ("XK" for
 *      Kosovo — not an official ISO 3166-1 entry, even though widely
 *      used; "EU" — not a country; "ZZ" — placeholder). Without a
 *      hard whitelist these render as orphaned chips with no flag.
 *
 * This module exports:
 *   - ALPHA2_SET            — canonical Set of valid 2-letter codes
 *   - normalizeIso(value)   — returns a canonical alpha-2 code or null:
 *                             * lowercases / uppercases handled
 *                             * UK → GB alias
 *                             * XK kept (Kosovo, widely used in practice)
 *                             * alpha-3 looked up via ALPHA3_TO_ALPHA2
 *                             * anything else returns null
 *   - normalizeIsoList(arr) — applies normalizeIso to an array, drops
 *                             nulls, dedupes (preserves first occurrence)
 *
 * NOTE: We accept XK (Kosovo) in our whitelist even though it isn't an
 * official ISO 3166-1 alpha-2 — flagcdn.com serves /xk.png and the rest
 * of our data pipeline treats Kosovo as a country. If we ever switch
 * the flag source, XK may need its own handling.
 */

// Official ISO 3166-1 alpha-2 codes plus XK (de-facto). Kept as a flat
// list for grep-ability and easy review.
const ALPHA2_LIST = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS',
  'XK',   // Kosovo (not official ISO 3166-1 but widely used + supported by flagcdn)
  'YE','YT',
  'ZA','ZM','ZW',
];

const ALPHA2_SET = new Set(ALPHA2_LIST);

// Alpha-3 → Alpha-2 mapping. Kept as a single object literal so future
// drift between this and ALPHA2_LIST is grep-able. Values intentionally
// limited to the ~250 codes used by ISO 3166-1; not every alpha-3 needs
// a mapping — only the ones we plausibly see in our data.
const ALPHA3_TO_ALPHA2 = {
  AFG:'AF', ALA:'AX', ALB:'AL', DZA:'DZ', ASM:'AS', AND:'AD', AGO:'AO', AIA:'AI',
  ATA:'AQ', ATG:'AG', ARG:'AR', ARM:'AM', ABW:'AW', AUS:'AU', AUT:'AT', AZE:'AZ',
  BHS:'BS', BHR:'BH', BGD:'BD', BRB:'BB', BLR:'BY', BEL:'BE', BLZ:'BZ', BEN:'BJ',
  BMU:'BM', BTN:'BT', BOL:'BO', BES:'BQ', BIH:'BA', BWA:'BW', BVT:'BV', BRA:'BR',
  IOT:'IO', BRN:'BN', BGR:'BG', BFA:'BF', BDI:'BI', CPV:'CV', KHM:'KH', CMR:'CM',
  CAN:'CA', CYM:'KY', CAF:'CF', TCD:'TD', CHL:'CL', CHN:'CN', CXR:'CX', CCK:'CC',
  COL:'CO', COM:'KM', COD:'CD', COG:'CG', COK:'CK', CRI:'CR', CIV:'CI', HRV:'HR',
  CUB:'CU', CUW:'CW', CYP:'CY', CZE:'CZ', DNK:'DK', DJI:'DJ', DMA:'DM', DOM:'DO',
  ECU:'EC', EGY:'EG', SLV:'SV', GNQ:'GQ', ERI:'ER', EST:'EE', SWZ:'SZ', ETH:'ET',
  FLK:'FK', FRO:'FO', FJI:'FJ', FIN:'FI', FRA:'FR', GUF:'GF', PYF:'PF', ATF:'TF',
  GAB:'GA', GMB:'GM', GEO:'GE', DEU:'DE', GHA:'GH', GIB:'GI', GRC:'GR', GRL:'GL',
  GRD:'GD', GLP:'GP', GUM:'GU', GTM:'GT', GGY:'GG', GIN:'GN', GNB:'GW', GUY:'GY',
  HTI:'HT', HMD:'HM', VAT:'VA', HND:'HN', HKG:'HK', HUN:'HU', ISL:'IS', IND:'IN',
  IDN:'ID', IRN:'IR', IRQ:'IQ', IRL:'IE', IMN:'IM', ISR:'IL', ITA:'IT', JAM:'JM',
  JPN:'JP', JEY:'JE', JOR:'JO', KAZ:'KZ', KEN:'KE', KIR:'KI', PRK:'KP', KOR:'KR',
  KWT:'KW', KGZ:'KG', LAO:'LA', LVA:'LV', LBN:'LB', LSO:'LS', LBR:'LR', LBY:'LY',
  LIE:'LI', LTU:'LT', LUX:'LU', MAC:'MO', MKD:'MK', MDG:'MG', MWI:'MW', MYS:'MY',
  MDV:'MV', MLI:'ML', MLT:'MT', MHL:'MH', MTQ:'MQ', MRT:'MR', MUS:'MU', MYT:'YT',
  MEX:'MX', FSM:'FM', MDA:'MD', MCO:'MC', MNG:'MN', MNE:'ME', MSR:'MS', MAR:'MA',
  MOZ:'MZ', MMR:'MM', NAM:'NA', NRU:'NR', NPL:'NP', NLD:'NL', NCL:'NC', NZL:'NZ',
  NIC:'NI', NER:'NE', NGA:'NG', NIU:'NU', NFK:'NF', MNP:'MP', NOR:'NO', OMN:'OM',
  PAK:'PK', PLW:'PW', PSE:'PS', PAN:'PA', PNG:'PG', PRY:'PY', PER:'PE', PHL:'PH',
  PCN:'PN', POL:'PL', PRT:'PT', PRI:'PR', QAT:'QA', REU:'RE', ROU:'RO', RUS:'RU',
  RWA:'RW', BLM:'BL', SHN:'SH', KNA:'KN', LCA:'LC', MAF:'MF', SPM:'PM', VCT:'VC',
  WSM:'WS', SMR:'SM', STP:'ST', SAU:'SA', SEN:'SN', SRB:'RS', SYC:'SC', SLE:'SL',
  SGP:'SG', SXM:'SX', SVK:'SK', SVN:'SI', SLB:'SB', SOM:'SO', ZAF:'ZA', SGS:'GS',
  SSD:'SS', ESP:'ES', LKA:'LK', SDN:'SD', SUR:'SR', SJM:'SJ', SWE:'SE', CHE:'CH',
  SYR:'SY', TWN:'TW', TJK:'TJ', TZA:'TZ', THA:'TH', TLS:'TL', TGO:'TG', TKL:'TK',
  TON:'TO', TTO:'TT', TUN:'TN', TUR:'TR', TKM:'TM', TCA:'TC', TUV:'TV', UGA:'UG',
  UKR:'UA', ARE:'AE', GBR:'GB', USA:'US', UMI:'UM', URY:'UY', UZB:'UZ', VUT:'VU',
  VEN:'VE', VNM:'VN', VGB:'VG', VIR:'VI', WLF:'WF', ESH:'EH', YEM:'YE', ZMB:'ZM',
  ZWE:'ZW',
  // Kosovo doesn't have an official ISO 3166-1 entry; XKX is the common
  // de-facto alpha-3 used in stats systems, paired with our XK alpha-2.
  XKX:'XK',
};

/**
 * Canonicalize a single value to a known alpha-2 code, or return null
 * if the value isn't a recognizable country code.
 *
 *   normalizeIso('PL')   → 'PL'
 *   normalizeIso('pl')   → 'PL'
 *   normalizeIso('POL')  → 'PL'   (alpha-3 → alpha-2)
 *   normalizeIso('uk')   → 'GB'   (legacy alias)
 *   normalizeIso('EU')   → null   (not a country)
 *   normalizeIso('XX')   → null   (placeholder)
 *   normalizeIso('  PL ')→ 'PL'   (whitespace tolerated)
 *   normalizeIso(null)   → null
 */
function normalizeIso(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  // Alpha-2 with legacy alias.
  if (upper === 'UK') return 'GB';
  if (upper.length === 2) {
    return ALPHA2_SET.has(upper) ? upper : null;
  }
  // Alpha-3 → alpha-2.
  if (upper.length === 3) {
    return ALPHA3_TO_ALPHA2[upper] || null;
  }
  return null;
}

/**
 * Normalize an array of codes. Drops nulls and dedupes (preserves
 * first occurrence so caller-specified priority is honored).
 */
function normalizeIsoList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const iso = normalizeIso(v);
    if (!iso || seen.has(iso)) continue;
    seen.add(iso);
    out.push(iso);
  }
  return out;
}

module.exports = {
  ALPHA2_SET,
  ALPHA3_TO_ALPHA2,
  normalizeIso,
  normalizeIsoList,
};
