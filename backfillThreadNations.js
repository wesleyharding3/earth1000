/**
 * backfillThreadNations.js
 *
 * One-shot backfill for story_threads.{primary_nations, secondary_nations}
 * that reasons about what a story is ABOUT, not where it was reported from.
 *
 * Signals (in order of precedence):
 *   1. article_locations.routing_type = 'content'
 *        → entity-extracted countries actually mentioned in the article
 *          body / summary. Full weight.
 *   2. article_entities.entity_type = 'organization'
 *        → when an article mentions NATO / EU / BRICS / Mercosur / etc.,
 *          expand to that bloc's member states with HALF weight per member.
 *          A single "NATO" mention therefore adds 0.5 to each of the 32
 *          member countries; if the article also directly mentions Poland,
 *          Poland gets 1.0 (direct) + 0.5 (NATO) = 1.5 total.
 *   3. article_locations.routing_type = 'source'
 *        → origin country of the outlet. LOWEST weight (0.2) and only a
 *          tiebreaker. Stops "Turkey publishes about Russia-Ukraine →
 *          Turkey tagged as primary" which was the exact failure mode.
 *
 * After the weighted tally, each thread gets:
 *   primary_nations   = top ISOs whose weight is ≥ 40% of the top score
 *                       (capped at 4)
 *   secondary_nations = next ISOs down to 15% of the top score (capped at 6)
 *
 * Then we run the improved dedup pass so the existing Hormuz / Denmark /
 * Iran-Mossad dupes collapse in the same run.
 *
 * Usage:
 *   node backfillThreadNations.js           — process active + cooling
 *   node backfillThreadNations.js --all     — include dormant too
 *   node backfillThreadNations.js --dry-run — log plans without writing
 */

require("dotenv").config();
const pool = require("./db");

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_DORMANT = process.argv.includes("--all");

// ─── International org → member states map ───────────────────────────────────
// Names list is matched against article_entities.entity_text (case/whitespace
// normalized). Any entity whose normalized text equals any entry in `names`
// expands to the `members` ISO list at half weight. When you notice a new
// bloc being mis-attributed, add it here.
const ORG_MEMBERS = {
  nato: {
    names: [
      "nato", "north atlantic treaty organization", "north atlantic alliance",
      "atlantic alliance", "otan",
    ],
    members: [
      "US","GB","FR","DE","IT","ES","PL","TR","CA","NL","BE","NO","DK","GR",
      "PT","LU","IS","CZ","HU","SK","SI","EE","LV","LT","BG","RO","HR","AL",
      "ME","MK","FI","SE",
    ],
  },
  eu: {
    names: [
      "european union", "eu", "european commission", "european parliament",
      "european council", "council of the european union",
    ],
    members: [
      "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE",
      "IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
    ],
  },
  brics: {
    names: ["brics", "brics+", "brics plus"],
    // Original 5 + 2024 accessions. SA here = South Africa (ZA); listed
    // by ISO below to avoid ambiguity with Saudi Arabia (SA).
    members: ["BR","RU","IN","CN","ZA","IR","AE","EG","ET"],
  },
  mercosur: {
    names: ["mercosur", "mercosul", "southern common market"],
    members: ["AR","BR","PY","UY","VE","BO"],
  },
  g7: {
    names: ["g7", "g-7", "group of seven", "g7 nations"],
    members: ["US","CA","FR","DE","IT","JP","GB"],
  },
  g20: {
    names: ["g20", "g-20", "group of twenty", "g20 nations"],
    members: [
      "US","CA","FR","DE","IT","JP","GB","AR","AU","BR","CN","IN","ID","MX",
      "RU","SA","ZA","KR","TR",
    ],
  },
  asean: {
    names: ["asean", "association of southeast asian nations"],
    members: ["BN","KH","ID","LA","MY","MM","PH","SG","TH","VN"],
  },
  gcc: {
    names: ["gcc", "gulf cooperation council"],
    members: ["SA","KW","BH","QA","AE","OM"],
  },
  arab_league: {
    names: ["arab league", "league of arab states"],
    members: [
      "DZ","BH","KM","DJ","EG","IQ","JO","KW","LB","LY","MR","MA","OM","PS",
      "QA","SA","SO","SD","SY","TN","AE","YE",
    ],
  },
  opec: {
    names: ["opec", "opec+", "organization of the petroleum exporting countries"],
    members: ["DZ","AO","CG","GQ","GA","IR","IQ","KW","LY","NG","SA","AE","VE"],
  },
  sco: {
    names: ["sco", "shanghai cooperation organization", "shanghai cooperation organisation"],
    members: ["CN","RU","IN","PK","KZ","KG","TJ","UZ","IR","BY"],
  },
  african_union: {
    names: ["african union", "au ", "l'union africaine", "union africaine"],
    // 55 member states; kept compact in one line.
    members: [
      "DZ","AO","BJ","BW","BF","BI","CM","CV","CF","TD","KM","CG","CD","CI",
      "DJ","EG","GQ","ER","SZ","ET","GA","GM","GH","GN","GW","KE","LS","LR",
      "LY","MG","MW","ML","MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN",
      "SC","SL","SO","ZA","SS","SD","TZ","TG","TN","UG","EH","ZM","ZW",
    ],
  },
  nordic: {
    names: ["nordic council", "nordic states", "scandinavia", "scandinavian countries"],
    members: ["DK","FI","IS","NO","SE"],
  },
  unsc_p5: {
    names: [
      "un security council", "unsc", "security council permanent members",
      "p5", "p-5",
    ],
    members: ["US","GB","FR","RU","CN"],
  },
};

// Fast lookup: normalized name → bloc key
const _ORG_NAME_TO_KEY = new Map();
for (const [key, { names }] of Object.entries(ORG_MEMBERS)) {
  for (const n of names) {
    _ORG_NAME_TO_KEY.set(_normalizeEntityText(n), key);
  }
}
function _normalizeEntityText(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Country aliases for sanity-check ───────────────────────────────────────
// Built once from the `countries` table plus a hardcoded common-name map.
// Used to verify that any ISO we're about to assign actually appears in the
// thread's title / description / keywords — filters out `article_locations`
// rows where the content-routing algorithm mis-geocoded the article (e.g.
// a SpaceX story routed to MX, a Brazil story routed to BO, a France story
// routed to BB). Org-expanded ISOs skip this check because by design they
// may not be individually named in the text.
const _COUNTRY_ALIASES = new Map(); // ISO → Set<lowercase name tokens>
async function loadCountryAliases() {
  const { rows } = await pool.query(
    `SELECT iso_code, name FROM countries WHERE iso_code IS NOT NULL`
  );
  for (const r of rows) {
    const iso = String(r.iso_code).toUpperCase();
    if (!iso) continue;
    if (!_COUNTRY_ALIASES.has(iso)) _COUNTRY_ALIASES.set(iso, new Set());
    const set = _COUNTRY_ALIASES.get(iso);
    set.add(_normalizeEntityText(r.name));
  }
  // Hand-curated common-English aliases on top of the DB canonical names.
  const extras = {
    US: ["united states", "usa", "u s a", "u s", "america", "american", "americans"],
    GB: ["uk", "britain", "british", "united kingdom", "england", "english", "great britain", "brit", "brits"],
    RU: ["russia", "russian", "russians", "kremlin", "moscow"],
    CN: ["china", "chinese", "beijing", "pla", "prc"],
    IR: ["iran", "iranian", "iranians", "tehran", "persia", "persian"],
    KR: ["south korea", "korean", "seoul"],
    KP: ["north korea", "pyongyang", "dprk"],
    DE: ["germany", "german", "germans", "berlin"],
    FR: ["france", "french", "paris"],
    JP: ["japan", "japanese", "tokyo"],
    IL: ["israel", "israeli", "israelis", "jerusalem", "tel aviv", "idf"],
    PS: ["palestine", "palestinian", "palestinians", "gaza", "west bank"],
    LB: ["lebanon", "lebanese", "beirut", "hezbollah"],
    SY: ["syria", "syrian", "damascus"],
    IQ: ["iraq", "iraqi", "baghdad"],
    SA: ["saudi", "saudi arabia", "riyadh"],
    AE: ["uae", "emirates", "dubai", "abu dhabi"],
    TR: ["turkey", "turkish", "ankara", "istanbul", "erdogan"],
    UA: ["ukraine", "ukrainian", "ukrainians", "kyiv", "kiev"],
    PL: ["poland", "polish", "warsaw"],
    MX: ["mexico", "mexican", "mexicans", "mexico city", "sheinbaum"],
    BR: ["brazil", "brazilian", "brasilia", "bolsonaro", "lula"],
    AR: ["argentina", "argentine", "buenos aires", "milei"],
    IN: ["india", "indian", "new delhi", "modi"],
    PK: ["pakistan", "pakistani", "islamabad", "karachi"],
    NG: ["nigeria", "nigerian", "abuja", "lagos"],
    ZA: ["south africa", "south african", "pretoria", "johannesburg"],
    EG: ["egypt", "egyptian", "cairo"],
    ET: ["ethiopia", "ethiopian", "addis ababa"],
    KE: ["kenya", "kenyan", "nairobi"],
    SO: ["somalia", "somali", "mogadishu"],
    SD: ["sudan", "sudanese", "khartoum"],
    VE: ["venezuela", "venezuelan", "caracas", "maduro"],
    CO: ["colombia", "colombian", "bogota"],
    PE: ["peru", "peruvian", "lima"],
    CL: ["chile", "chilean", "santiago"],
    CU: ["cuba", "cuban", "havana"],
    CA: ["canada", "canadian", "ottawa", "toronto", "carney"],
    AU: ["australia", "australian", "canberra", "sydney"],
    NZ: ["new zealand", "auckland", "wellington"],
    ES: ["spain", "spanish", "madrid"],
    IT: ["italy", "italian", "rome"],
    NL: ["netherlands", "dutch", "amsterdam", "the hague"],
    BE: ["belgium", "belgian", "brussels"],
    CH: ["switzerland", "swiss", "geneva", "bern"],
    AT: ["austria", "austrian", "vienna"],
    SE: ["sweden", "swedish", "stockholm"],
    NO: ["norway", "norwegian", "oslo"],
    DK: ["denmark", "danish", "copenhagen"],
    FI: ["finland", "finnish", "helsinki"],
    IS: ["iceland", "icelandic", "reykjavik"],
    GR: ["greece", "greek", "athens"],
    PT: ["portugal", "portuguese", "lisbon"],
    IE: ["ireland", "irish", "dublin"],
    CZ: ["czechia", "czech", "prague", "czech republic"],
    HU: ["hungary", "hungarian", "budapest", "orban", "magyar"],
    RO: ["romania", "romanian", "bucharest"],
    BG: ["bulgaria", "bulgarian", "sofia"],
    HR: ["croatia", "croatian", "zagreb"],
    SK: ["slovakia", "slovak", "bratislava", "fico"],
    SI: ["slovenia", "slovenian", "ljubljana"],
    EE: ["estonia", "estonian", "tallinn"],
    LV: ["latvia", "latvian", "riga"],
    LT: ["lithuania", "lithuanian", "vilnius"],
    BY: ["belarus", "belarusian", "minsk", "lukashenko"],
    MD: ["moldova", "moldovan", "chisinau"],
    RS: ["serbia", "serbian", "belgrade"],
    BA: ["bosnia", "bosnian", "sarajevo"],
    XK: ["kosovo", "kosovar", "pristina"],
    MK: ["north macedonia", "macedonian", "skopje"],
    AL: ["albania", "albanian", "tirana"],
    ME: ["montenegro", "podgorica"],
    TH: ["thailand", "thai", "bangkok"],
    VN: ["vietnam", "vietnamese", "hanoi"],
    PH: ["philippines", "filipino", "manila"],
    ID: ["indonesia", "indonesian", "jakarta"],
    MY: ["malaysia", "malaysian", "kuala lumpur"],
    SG: ["singapore", "singaporean"],
    TW: ["taiwan", "taiwanese", "taipei"],
    HK: ["hong kong", "hongkong"],
    BD: ["bangladesh", "bangladeshi", "dhaka"],
    LK: ["sri lanka", "sri lankan", "colombo"],
    NP: ["nepal", "nepali", "kathmandu"],
    MM: ["myanmar", "burma", "burmese"],
    KH: ["cambodia", "cambodian", "phnom penh"],
    LA: ["laos", "laotian", "vientiane"],
    AF: ["afghanistan", "afghan", "kabul", "taliban"],
    MA: ["morocco", "moroccan", "rabat", "casablanca"],
    DZ: ["algeria", "algerian", "algiers"],
    TN: ["tunisia", "tunisian", "tunis"],
    LY: ["libya", "libyan", "tripoli"],
    JO: ["jordan", "jordanian", "amman"],
    KW: ["kuwait", "kuwaiti"],
    QA: ["qatar", "qatari", "doha"],
    YE: ["yemen", "yemeni", "houthi", "houthis"],
    OM: ["oman", "omani", "muscat"],
    BH: ["bahrain", "bahraini", "manama"],
    AZ: ["azerbaijan", "azerbaijani", "baku"],
    AM: ["armenia", "armenian", "yerevan"],
    GE: ["georgia", "georgian", "tbilisi"],
    KZ: ["kazakhstan", "kazakh", "astana", "nur-sultan"],
    UZ: ["uzbekistan", "uzbek", "tashkent"],
    KG: ["kyrgyzstan", "kyrgyz", "bishkek"],
    TJ: ["tajikistan", "tajik", "dushanbe"],
    TM: ["turkmenistan", "turkmen", "ashgabat"],
    MN: ["mongolia", "mongolian", "ulaanbaatar"],
    CD: ["drc", "congo-kinshasa", "democratic republic of the congo", "dr congo"],
    CG: ["congo-brazzaville", "republic of the congo"],
    TZ: ["tanzania", "tanzanian", "dar es salaam", "dodoma"],
    UG: ["uganda", "ugandan", "kampala"],
    RW: ["rwanda", "rwandan", "kigali"],
    GH: ["ghana", "ghanaian", "accra"],
    CI: ["ivory coast", "cote d'ivoire", "ivorian", "abidjan"],
    SN: ["senegal", "senegalese", "dakar"],
    MR: ["mauritania", "mauritanian", "nouakchott"],
    ML: ["mali", "malian", "bamako"],
    BF: ["burkina faso", "burkinabe", "ouagadougou"],
    NE: ["niger", "nigerien", "niamey"],
    TD: ["chad", "chadian", "ndjamena"],
    CM: ["cameroon", "cameroonian", "yaounde"],
    GQ: ["equatorial guinea", "malabo"],
    GN: ["guinea", "conakry"],
    GW: ["guinea-bissau", "bissau"],
    LR: ["liberia", "liberian", "monrovia"],
    SL: ["sierra leone", "freetown"],
    SS: ["south sudan", "juba"],
    ER: ["eritrea", "eritrean", "asmara"],
    DJ: ["djibouti", "djiboutian"],
    MG: ["madagascar", "malagasy", "antananarivo"],
    MU: ["mauritius", "mauritian", "port louis"],
    ZM: ["zambia", "zambian", "lusaka"],
    ZW: ["zimbabwe", "zimbabwean", "harare"],
    AO: ["angola", "angolan", "luanda"],
    MZ: ["mozambique", "mozambican", "maputo"],
    BW: ["botswana", "gaborone"],
    NA: ["namibia", "namibian", "windhoek"],
    LS: ["lesotho", "maseru"],
    SZ: ["eswatini", "swaziland", "mbabane"],
    EH: ["western sahara"],
  };
  for (const [iso, names] of Object.entries(extras)) {
    if (!_COUNTRY_ALIASES.has(iso)) _COUNTRY_ALIASES.set(iso, new Set());
    const set = _COUNTRY_ALIASES.get(iso);
    for (const n of names) set.add(_normalizeEntityText(n));
  }
}

function isoAppearsInCorpus(iso, corpus) {
  const aliases = _COUNTRY_ALIASES.get(iso);
  if (!aliases) return false;
  for (const alias of aliases) {
    if (!alias) continue;
    // Word-boundary match so "IL" doesn't hit "ILLusion" or "ILLinois" and
    // "MR" doesn't false-hit a lone "Mr." prefix.
    const re = new RegExp(`\\b${escapeRe(alias)}\\b`);
    if (re.test(corpus)) return true;
  }
  return false;
}

// Rescue scan: count total alias-match occurrences per ISO across the
// thread's corpus (title + description + keywords, already normalized).
// Cap per ISO at 2 hits so one highly-repeated country doesn't dominate a
// thread that mentions many actors.
function corpusCountrySignals(corpus) {
  const weights = Object.create(null);
  for (const [iso, aliases] of _COUNTRY_ALIASES.entries()) {
    let n = 0;
    for (const alias of aliases) {
      if (!alias) continue;
      const re = new RegExp(`\\b${escapeRe(alias)}\\b`, "g");
      const matches = corpus.match(re);
      if (matches) n += matches.length;
    }
    if (n > 0) weights[iso] = Math.min(2, n) * 0.7;
  }
  return weights;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const statusClause = INCLUDE_DORMANT
    ? `status IN ('active','cooling','dormant')`
    : `status IN ('active','cooling')`;

  console.log(`\n🌍 Thread Nations Backfill — ${new Date().toISOString()}`);
  console.log(`   mode: ${DRY_RUN ? "DRY RUN (no writes)" : "WRITE"} | scope: ${statusClause}\n`);

  await loadCountryAliases();
  console.log(`   [${elapsed()}] Loaded ${_COUNTRY_ALIASES.size} country alias sets`);

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, keywords, primary_nations, secondary_nations,
           article_count, status
    FROM story_threads
    WHERE ${statusClause}
    ORDER BY article_count DESC, id ASC
  `);
  console.log(`   [${elapsed()}] Loaded ${threads.length} threads`);

  let updated = 0;
  let skipped_no_articles = 0;
  let skipped_unchanged = 0;

  // Corpus builder — title + description + top keywords joined and normalized.
  // Used by the title/keyword sanity check to filter out ISOs that nothing
  // in the thread actually references (data-quality failsafe).
  const buildCorpus = (t) => {
    const parts = [
      t.title || "",
      t.description || "",
      Array.isArray(t.keywords) ? t.keywords.join(" ") : "",
    ];
    return _normalizeEntityText(parts.join(" "));
  };

  for (const t of threads) {
    // Always build the corpus and attempt partitioning, even for threads
    // where article_locations / article_entities have zero rows — the
    // corpus-rescue pass in partitionSignals can still extract country
    // mentions from the thread's own title / description / keywords.
    const signals = await computeThreadNationSignals(t.id)
      || { direct: {}, org: {}, source: {} };
    const corpus = buildCorpus(t);
    const { primary, secondary } = partitionSignals(signals, corpus);

    if (!primary.length && !secondary.length) {
      skipped_no_articles++;
      continue;
    }

    // If already correct, skip the UPDATE to keep last_updated_at stable.
    const currentPrimary = normArr(t.primary_nations);
    const currentSecondary = normArr(t.secondary_nations);
    if (sameArr(currentPrimary, primary) && sameArr(currentSecondary, secondary)) {
      skipped_unchanged++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `   [plan ${t.id}] "${String(t.title).slice(0, 60)}" ` +
        `primary=[${primary.join(",")}] secondary=[${secondary.join(",")}]`
      );
    } else {
      await pool.query(
        `UPDATE story_threads
         SET primary_nations = $1::text[], secondary_nations = $2::text[]
         WHERE id = $3`,
        [primary, secondary, t.id]
      );
    }
    updated++;
    if (updated % 50 === 0) {
      console.log(`   [${elapsed()}] Processed ${updated} threads...`);
    }
  }

  console.log(
    `\n   [${elapsed()}] Nation backfill complete. ` +
    `updated=${updated} unchanged=${skipped_unchanged} no_article_context=${skipped_no_articles}`
  );

  // ── Run dedup pass on the now-populated threads ────────────────────────
  if (!DRY_RUN) {
    console.log(`\n   [${elapsed()}] Running dedup pass...`);
    const { dedupSimilarThreads } = require("./storyThreadBuilder");
    const merged = await dedupSimilarThreads();
    console.log(`   [${elapsed()}] Dedup merged ${merged} duplicate thread(s)`);
  }

  await pool.end();
  console.log(`\n✅ Done in ${elapsed()}.\n`);
}

// ─── Signal collection ──────────────────────────────────────────────────────
// Returns three separate weight maps keyed by ISO. Separating by signal type
// lets the partition step treat them differently:
//   - direct: content-extracted mentions; eligible for primary tier
//   - org:    org-expansion (NATO/EU/BRICS/etc); secondary-only
//   - source: publication origin; low-weight tiebreaker, secondary-only
async function computeThreadNationSignals(threadId) {
  const direct = Object.create(null);
  const org = Object.create(null);
  const source = Object.create(null);
  const bump = (target, iso, w) => {
    if (!iso) return;
    const code = String(iso).toUpperCase();
    const fixed = code === "UK" ? "GB" : code;
    target[fixed] = (target[fixed] || 0) + w;
  };

  const { rows: contentRows } = await pool.query(
    `
    SELECT co.iso_code, COUNT(DISTINCT a.id)::int AS n
    FROM story_thread_articles sta
    JOIN news_articles a       ON a.id = sta.article_id
    JOIN article_locations al  ON al.article_id = a.id AND al.routing_type = 'content'
    JOIN countries co          ON co.id = al.country_id
    WHERE sta.thread_id = $1
    GROUP BY co.iso_code
    `,
    [threadId]
  );
  for (const r of contentRows) bump(direct, r.iso_code, r.n * 1.0);

  const { rows: orgRows } = await pool.query(
    `
    SELECT LOWER(TRIM(ae.entity_text)) AS entity_text,
           COUNT(DISTINCT a.id)::int AS n
    FROM story_thread_articles sta
    JOIN news_articles a     ON a.id = sta.article_id
    JOIN article_entities ae ON ae.article_id = a.id AND ae.entity_type = 'organization'
    WHERE sta.thread_id = $1
    GROUP BY LOWER(TRIM(ae.entity_text))
    `,
    [threadId]
  );
  for (const r of orgRows) {
    const key = _ORG_NAME_TO_KEY.get(_normalizeEntityText(r.entity_text));
    if (!key) continue;
    const members = ORG_MEMBERS[key].members;
    // Scale per-member weight down for larger blocs so a single NATO or EU
    // mention doesn't swamp the tally. Cap at 0.5 per member for small
    // blocs (G7, GCC) and attenuate toward ~0.15 for large ones (55-member
    // African Union). Formula: 0.5 * (7 / max(members.length, 7))  capped.
    const perMember = Math.min(0.5, 3.5 / Math.max(members.length, 7));
    for (const iso of members) bump(org, iso, r.n * perMember);
  }

  const { rows: sourceRows } = await pool.query(
    `
    SELECT co.iso_code, COUNT(DISTINCT a.id)::int AS n
    FROM story_thread_articles sta
    JOIN news_articles a       ON a.id = sta.article_id
    JOIN article_locations al  ON al.article_id = a.id AND al.routing_type = 'source'
    JOIN countries co          ON co.id = al.country_id
    WHERE sta.thread_id = $1
    GROUP BY co.iso_code
    `,
    [threadId]
  );
  for (const r of sourceRows) bump(source, r.iso_code, r.n * 0.2);

  return { direct, org, source };
}

// ─── Partition into primary / secondary ──────────────────────────────────────
// Rules (with refinements from dry-run findings):
//   1. Primary tier comes ONLY from direct content signal. Org expansion and
//      source origin never contribute to primary. This prevents an article
//      mentioning "EU" from pushing 27 alphabetical member states into the
//      primary slot when the actual lead actor is one named country.
//   2. Title/keyword sanity check: a candidate direct or source ISO must
//      have at least one of its country-name aliases appear in the thread's
//      corpus (title + description + keywords). This filters out the
//      data-quality failures in article_locations (SpaceX→MX, Brazil→BO,
//      France→BB etc) by requiring some textual evidence. Org-expanded
//      ISOs skip this check — they're supposed to show blocs whose members
//      aren't individually named.
//   3. Secondary tier accepts the leftover direct ISOs (below primary floor)
//      plus all org and source signals, ranked by combined weight.
function partitionSignals({ direct, org, source }, corpus) {
  // Step 1: sanity-filter direct + source by corpus.
  const directFiltered = {};
  for (const [iso, w] of Object.entries(direct)) {
    if (isoAppearsInCorpus(iso, corpus)) directFiltered[iso] = w;
  }
  const sourceFiltered = {};
  for (const [iso, w] of Object.entries(source)) {
    if (isoAppearsInCorpus(iso, corpus)) sourceFiltered[iso] = w;
  }

  // Step 1b: corpus rescue signal. Scan the thread's own title / description
  // / keywords for country names and add them to the direct pool at a
  // moderate weight. This compensates for article_locations rows that are
  // missing or mis-geocoded for threads whose own text unambiguously names
  // a country (the Poland-Russia, Brazil-Bolsonaro, Mauritanian-Paris
  // cases we saw going to empty primary in the first dry-run).
  //   - Per-mention weight: 0.7 (below a single direct mention at 1.0)
  //   - Capped at 2 mentions per ISO so one repeated country can't dominate
  //     a thread that mentions a dozen other countries in passing.
  const corpusWeights = corpusCountrySignals(corpus);
  for (const [iso, w] of Object.entries(corpusWeights)) {
    directFiltered[iso] = (directFiltered[iso] || 0) + w;
  }

  // Step 2: primary tier from direct only (now augmented by corpus rescue).
  const directEntries = Object.entries(directFiltered).sort((a, b) => b[1] - a[1]);
  const topDirect = directEntries[0]?.[1] || 0;
  const PRIMARY_FLOOR = topDirect * 0.40;
  const primary = [];
  const leftover = [];
  for (const [iso, w] of directEntries) {
    if (w >= PRIMARY_FLOOR && primary.length < 4) primary.push(iso);
    else leftover.push([iso, w]);
  }

  // Step 3: secondary tier = leftover direct + all org + all sanity-passed
  // source, combined by ISO, then ranked. Primary ISOs are excluded so they
  // don't double-appear. Floor is 15% of the secondary pool's top weight
  // (not the direct top), so even a secondary-only scenario surfaces real
  // signal.
  const primarySet = new Set(primary);
  const combined = Object.create(null);
  const add = (iso, w) => {
    if (primarySet.has(iso)) return;
    combined[iso] = (combined[iso] || 0) + w;
  };
  for (const [iso, w] of leftover) add(iso, w);
  for (const [iso, w] of Object.entries(org)) add(iso, w);
  for (const [iso, w] of Object.entries(sourceFiltered)) add(iso, w);

  const secondaryEntries = Object.entries(combined).sort((a, b) => b[1] - a[1]);
  const topSecondary = secondaryEntries[0]?.[1] || 0;
  const SECONDARY_FLOOR = topSecondary * 0.15;
  const secondary = [];
  for (const [iso, w] of secondaryEntries) {
    if (w < SECONDARY_FLOOR) break;
    if (secondary.length >= 6) break;
    secondary.push(iso);
  }

  return { primary, secondary };
}

function normArr(a) {
  return Array.isArray(a) ? a.map(s => String(s || "").toUpperCase()).filter(Boolean) : [];
}
function sameArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
