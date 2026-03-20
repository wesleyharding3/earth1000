// enrichImageLocations.js
//
// Parses city and country names from image filenames and sets
// city_id / country_id on image_assets rows.
//
// Handles three filename patterns:
//   "City,_Country3.jpg"        → city + country
//   "Country15.jpg"             → country only
//   "Chinese_navy2.jpg"         → adjective → country lookup
//   "topic_description_hash.jpg"→ no location (skipped)
//
// Usage:
//   node enrichImageLocations.js --dry-run   # preview only
//   node enrichImageLocations.js             # apply updates

require("dotenv").config();
const pool = require("./db");

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Demonym → country map ─────────────────────────────────────
// Single-word demonyms (first token of filename, lowercased, digits stripped)
// e.g. "Indian_military_jets2.jpg" → first token "indian" → "India"
const ADJECTIVE_TO_COUNTRY = {
  // A
  afghan: "Afghanistan", albanian: "Albania", algerian: "Algeria",
  american: "United States", angolan: "Angola", argentinian: "Argentina",
  argentine: "Argentina", armenian: "Armenia", australian: "Australia",
  austrian: "Austria", azerbaijani: "Azerbaijan",
  // B
  bahraini: "Bahrain", bangladeshi: "Bangladesh", belarusian: "Belarus",
  belgian: "Belgium", belizean: "Belize", beninese: "Benin",
  bhutanese: "Bhutan", bolivian: "Bolivia", bosnian: "Bosnia and Herzegovina",
  botswanan: "Botswana", brazilian: "Brazil", british: "United Kingdom",
  bruneian: "Brunei", bulgarian: "Bulgaria", burkinabe: "Burkina Faso",
  burundian: "Burundi", burmese: "Myanmar",
  // C
  cambodian: "Cambodia", cameroonian: "Cameroon", canadian: "Canada",
  chadian: "Chad", chilean: "Chile", chinese: "China",
  colombian: "Colombia", congolese: "Congo", croatian: "Croatia",
  cuban: "Cuba", cypriot: "Cyprus", czech: "Czech Republic",
  // D
  danish: "Denmark", djiboutian: "Djibouti", dominican: "Dominican Republic",
  dutch: "Netherlands",
  // E
  ecuadorian: "Ecuador", egyptian: "Egypt", emirati: "United Arab Emirates",
  eritrean: "Eritrea", estonian: "Estonia", ethiopian: "Ethiopia",
  // F
  fijian: "Fiji", filipino: "Philippines", finnish: "Finland",
  french: "France",
  // G
  gabonese: "Gabon", gambian: "Gambia", georgian: "Georgia",
  german: "Germany", ghanaian: "Ghana", greek: "Greece",
  guatemalan: "Guatemala", guinean: "Guinea",
  // H
  haitian: "Haiti", honduran: "Honduras", hungarian: "Hungary",
  // I
  icelandic: "Iceland", indian: "India", indonesian: "Indonesia",
  iranian: "Iran", iraqi: "Iraq", irish: "Ireland",
  israeli: "Israel", italian: "Italy", ivorian: "Ivory Coast",
  // J
  jamaican: "Jamaica", japanese: "Japan", jordanian: "Jordan",
  // K
  kazakh: "Kazakhstan", kenyan: "Kenya", korean: "South Korea",
  kuwaiti: "Kuwait", kyrgyz: "Kyrgyzstan",
  // L
  lao: "Laos", laotian: "Laos", latvian: "Latvia", lebanese: "Lebanon",
  liberian: "Liberia", libyan: "Libya", lithuanian: "Lithuania",
  // M
  macedonian: "North Macedonia", malagasy: "Madagascar",
  malawian: "Malawi", malaysian: "Malaysia", maldivian: "Maldives",
  malian: "Mali", maltese: "Malta", mauritanian: "Mauritania",
  mauritian: "Mauritius", mexican: "Mexico", moldovan: "Moldova",
  mongolian: "Mongolia", montenegrin: "Montenegro", moroccan: "Morocco",
  mozambican: "Mozambique", myanmar: "Myanmar",
  // N
  namibian: "Namibia", nepali: "Nepal", nepalese: "Nepal",
  nicaraguan: "Nicaragua", nigerien: "Niger", nigerian: "Nigeria",
  norwegian: "Norway",
  // O
  omani: "Oman",
  // P
  pakistani: "Pakistan", palestinian: "Palestine", panamanian: "Panama",
  paraguayan: "Paraguay", peruvian: "Peru", philippine: "Philippines",
  polish: "Poland", portuguese: "Portugal",
  // Q
  qatari: "Qatar",
  // R
  romanian: "Romania", russian: "Russia", rwandan: "Rwanda",
  // S
  salvadoran: "El Salvador", samoan: "Samoa", saudi: "Saudi Arabia",
  senegalese: "Senegal", serbian: "Serbia", singaporean: "Singapore",
  slovak: "Slovakia", slovenian: "Slovenia", somali: "Somalia",
  spanish: "Spain", sudanese: "Sudan", surinamese: "Suriname",
  swedish: "Sweden", swiss: "Switzerland", syrian: "Syria",
  // T
  taiwanese: "Taiwan", tajik: "Tajikistan", tanzanian: "Tanzania",
  thai: "Thailand", togolese: "Togo", tunisian: "Tunisia",
  turkish: "Turkey", turkmen: "Turkmenistan",
  // U
  ugandan: "Uganda", ukrainian: "Ukraine", uruguayan: "Uruguay",
  uzbek: "Uzbekistan",
  // V
  venezuelan: "Venezuela", vietnamese: "Vietnam",
  // Y
  yemeni: "Yemen",
  // Z
  zambian: "Zambia", zimbabwean: "Zimbabwe",
};

// Two-word demonyms — checked BEFORE single-word map
// e.g. "South_African_troops" → "south african" → "South Africa"
const TWO_WORD_DEMONYMS = {
  "south african":    "South Africa",
  "south korean":     "South Korea",
  "north korean":     "North Korea",
  "sri lankan":       "Sri Lanka",
  "new zealander":    "New Zealand",
  "new zealand":      "New Zealand",
  "costa rican":      "Costa Rica",
  "puerto rican":     "Puerto Rico",
  "saudi arabian":    "Saudi Arabia",
  "united states":    "United States",
  "el salvadoran":    "El Salvador",
  "ivory coast":      "Ivory Coast",
  "north macedonian": "North Macedonia",
  "central african":  "Central African Republic",
  "sierra leonean":   "Sierra Leone",
  "papua new guinean":"Papua New Guinea",
  "equatorial guinean":"Equatorial Guinea",
  "dominican republic":"Dominican Republic",
  "trinidad tobago":  "Trinidad and Tobago",
  "hong kong":        "Hong Kong",
  "czech republic":   "Czech Republic",
  "bosnian herzegovinian": "Bosnia and Herzegovina",
};

// ─── Parse filename into location candidates ────────────────────
function parseFilename(fileName) {
  // Strip extension and hash suffix (e.g. _aBcDeFg1234 at end)
  const stem = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/_[a-zA-Z0-9]{8,}$/, "")
    .trim();

  // Pattern 1: "City,_Country3" or "City,_Country"
  // Comma separates city from country
  const commaMatch = stem.match(/^([^,_][^,]+),_?([A-Za-z][A-Za-z_ ]+\d*)$/);
  if (commaMatch) {
    const city    = cleanToken(commaMatch[1]);
    const country = cleanToken(commaMatch[2].replace(/\d+$/, ""));
    return { city, country };
  }

  // Pattern 2: "_City_CountryN" or "_City_N"
  const leadingUnderscore = stem.match(/^_+([A-Za-z][A-Za-z_ ]+?)(?:_+([A-Za-z][A-Za-z ]+))?\d*$/);
  if (leadingUnderscore) {
    const city    = cleanToken(leadingUnderscore[1]);
    const country = leadingUnderscore[2] ? cleanToken(leadingUnderscore[2]) : null;
    return { city, country };
  }

  // Pattern 3: "CountryN" — starts with capital, ends with digits, no underscores before digits
  const countryOnly = stem.match(/^([A-Z][A-Za-z ]+?)\d+$/);
  if (countryOnly) {
    const name = cleanToken(countryOnly[1]);
    // Only treat as country if it looks like a proper noun (not a topic word)
    if (isProperNoun(name)) {
      return { city: null, country: name };
    }
  }

  // Pattern 4a: two-word demonym e.g. "South_African_troops3"
  const tokens = stem.split(/[_\s]/).map(t => t.toLowerCase().replace(/\d+$/, ""));
  if (tokens.length >= 2) {
    const twoWord = tokens.slice(0, 2).join(" ");
    const twoWordCountry = TWO_WORD_DEMONYMS[twoWord];
    if (twoWordCountry) return { city: null, country: twoWordCountry };
  }

  // Pattern 4b: single-word demonym e.g. "Chinese_navy19", "Indian_military"
  const firstToken = tokens[0];
  const mappedCountry = ADJECTIVE_TO_COUNTRY[firstToken];
  if (mappedCountry) {
    return { city: null, country: mappedCountry };
  }

  return null;
}

function cleanToken(str) {
  return str
    .replace(/_/g, " ")
    .replace(/\d+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Heuristic: proper noun if first letter caps and not a known topic word
const TOPIC_WORDS = new Set([
  "Bank", "Trade", "Finance", "Military", "Religion", "Cargo", "Harbor",
  "Port", "Factory", "Farm", "Church", "Mosque", "Temple", "Forest",
  "Mountain", "River", "Desert", "Glacier", "Coast", "Lake", "Sea",
  "News", "Medical", "Research", "Council", "Federal", "Parliament",
  "General", "Misc", "Landscape", "Commons", "Budget", "Vault",
  "Electronic", "Freight", "Grain", "Livestock", "Greenhouse", "Aid",
]);

function isProperNoun(name) {
  const first = name.split(" ")[0];
  return !TOPIC_WORDS.has(first) && /^[A-Z]/.test(first);
}

// ─── DB lookups ─────────────────────────────────────────────────
async function lookupCountry(name, client) {
  if (!name) return null;
  const { rows } = await client.query(
    `SELECT id FROM countries
     WHERE LOWER(name) = LOWER($1)
        OR LOWER(name) LIKE LOWER($1) || '%'
     ORDER BY LENGTH(name) ASC
     LIMIT 1`,
    [name]
  );
  return rows[0]?.id || null;
}

async function lookupCity(name, countryId, client) {
  if (!name) return null;
  const params = [name];
  const countryClause = countryId ? `AND country_id = $2` : "";
  if (countryId) params.push(countryId);

  const { rows } = await client.query(
    `SELECT id FROM cities
     WHERE (LOWER(name) = LOWER($1) OR LOWER(name) LIKE LOWER($1) || '%')
     ${countryClause}
     ORDER BY LENGTH(name) ASC
     LIMIT 1`,
    params
  );
  return rows[0]?.id || null;
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${DRY_RUN ? "🔍 DRY RUN — " : ""}🗺️  Image location enrichment`);

  const client = await pool.connect();

  try {
    // Fetch all images that don't have location set yet
    const { rows: images } = await client.query(`
      SELECT id, file_name, folder_path, object_path
      FROM image_assets
      WHERE city_id IS NULL AND country_id IS NULL
      ORDER BY id ASC
    `);

    console.log(`   ${images.length} images without location to process\n`);

    let updated    = 0;
    let cityHits   = 0;
    let countryHits = 0;
    let noMatch    = 0;

    for (const img of images) {
      const parsed = parseFilename(img.file_name);
      if (!parsed) {
        noMatch++;
        continue;
      }

      let countryId = await lookupCountry(parsed.country, client);
      let cityId    = parsed.city
        ? await lookupCity(parsed.city, countryId, client)
        : null;

      // Cross-lookup: if the "country" token didn't match a country,
      // try it as a city (e.g. "Mumbai1.jpg" → parsed as country="Mumbai"
      // but Mumbai is a city, not a country).
      if (!countryId && !cityId && parsed.country) {
        cityId = await lookupCity(parsed.country, null, client);
        if (cityId) {
          // Found it as a city — also pull its country
          const { rows: cityRows } = await client.query(
            `SELECT country_id FROM cities WHERE id = $1`, [cityId]
          );
          countryId = cityRows[0]?.country_id || null;
        }
      }

      // Cross-lookup: if the "city" token didn't match a city,
      // try it as a country (e.g. label swapped in filename).
      if (!cityId && parsed.city && !countryId) {
        countryId = await lookupCountry(parsed.city, client);
      }

      if (!countryId && !cityId) {
        console.log(`  ⚠️  [${img.id}] "${img.file_name}" → parsed "${parsed.city ?? ""}/${parsed.country ?? ""}" but no DB match`);
        noMatch++;
        continue;
      }

      const label = [cityId && `city:${cityId}`, countryId && `country:${countryId}`]
        .filter(Boolean).join(" ");
      console.log(`  ✅ [${img.id}] "${img.file_name}" → ${label}`);

      if (!DRY_RUN) {
        await client.query(
          `UPDATE image_assets
           SET city_id = $1, country_id = $2, updated_at = NOW()
           WHERE id = $3`,
          [cityId || null, countryId || null, img.id]
        );
      }

      updated++;
      if (cityId)    cityHits++;
      if (countryId) countryHits++;
    }

    console.log(`\n📊 Results:`);
    console.log(`   ✅ Updated:        ${updated}`);
    console.log(`   🏙️  City matched:   ${cityHits}`);
    console.log(`   🌍 Country matched: ${countryHits}`);
    console.log(`   ⏭️  No location:    ${noMatch}`);

    if (DRY_RUN) {
      console.log(`\n   Run without --dry-run to apply.`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("🚨 Fatal:", err);
  process.exit(1);
});