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

// ─── Adjective → country name map ──────────────────────────────
// For filenames like "Chinese_navy", "Turkish_jets", "Russian_..."
const ADJECTIVE_TO_COUNTRY = {
  afghan: "Afghanistan", african: null, albanian: "Albania",
  algerian: "Algeria", american: "United States", angolan: "Angola",
  argentinian: "Argentina", armenian: "Armenia", australian: "Australia",
  austrian: "Austria", azerbaijani: "Azerbaijan", bahraini: "Bahrain",
  bangladeshi: "Bangladesh", belarusian: "Belarus", belgian: "Belgium",
  bolivian: "Bolivia", bosnian: "Bosnia and Herzegovina",
  brazilian: "Brazil", british: "United Kingdom", bulgarian: "Bulgaria",
  burmese: "Myanmar", cambodian: "Cambodia", cameroonian: "Cameroon",
  canadian: "Canada", chilean: "Chile", chinese: "China",
  colombian: "Colombia", congolese: "Congo", croatian: "Croatia",
  cuban: "Cuba", czech: "Czech Republic", danish: "Denmark",
  dutch: "Netherlands", ecuadorian: "Ecuador", egyptian: "Egypt",
  emirati: "United Arab Emirates", eritrean: "Eritrea",
  estonian: "Estonia", ethiopian: "Ethiopia", finnish: "Finland",
  french: "France", georgian: "Georgia", german: "Germany",
  ghanaian: "Ghana", greek: "Greece", guatemalan: "Guatemala",
  honduran: "Honduras", hungarian: "Hungary", indian: "India",
  indonesian: "Indonesia", iranian: "Iran", iraqi: "Iraq",
  irish: "Ireland", israeli: "Israel", italian: "Italy",
  japanese: "Japan", jordanian: "Jordan", kazakh: "Kazakhstan",
  kenyan: "Kenya", korean: "South Korea", kuwaiti: "Kuwait",
  kyrgyz: "Kyrgyzstan", latvian: "Latvia", lebanese: "Lebanon",
  libyan: "Libya", lithuanian: "Lithuania", macedonian: "North Macedonia",
  malaysian: "Malaysia", mexican: "Mexico", moldovan: "Moldova",
  mongolian: "Mongolia", moroccan: "Morocco", mozambican: "Mozambique",
  myanmar: "Myanmar", namibian: "Namibia", nepali: "Nepal",
  nigerian: "Nigeria", norwegian: "Norway", omani: "Oman",
  pakistani: "Pakistan", palestinian: "Palestine", panamanian: "Panama",
  peruvian: "Peru", philippine: "Philippines", filipino: "Philippines",
  polish: "Poland", portuguese: "Portugal", qatari: "Qatar",
  romanian: "Romania", russian: "Russia", rwandan: "Rwanda",
  saudi: "Saudi Arabia", serbian: "Serbia", singaporean: "Singapore",
  slovak: "Slovakia", slovenian: "Slovenia", somali: "Somalia",
  southafrican: "South Africa", spanish: "Spain", sri: "Sri Lanka",
  sudanese: "Sudan", swedish: "Sweden", swiss: "Switzerland",
  syrian: "Syria", taiwanese: "Taiwan", tajik: "Tajikistan",
  tanzanian: "Tanzania", thai: "Thailand", tunisian: "Tunisia",
  turkish: "Turkey", turkmen: "Turkmenistan", ugandan: "Uganda",
  ukrainian: "Ukraine", uruguayan: "Uruguay", uzbek: "Uzbekistan",
  venezuelan: "Venezuela", vietnamese: "Vietnam", yemeni: "Yemen",
  zambian: "Zambia", zimbabwean: "Zimbabwe",
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

  // Pattern 4: "Adjective_topic_..." e.g. "Chinese_navy19"
  const firstToken = stem.split(/[_\s]/)[0].toLowerCase().replace(/\d+$/, "");
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
     WHERE LOWER(name) = LOWER($1)
     ${countryClause}
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

      const countryId = await lookupCountry(parsed.country, client);
      const cityId    = parsed.city
        ? await lookupCity(parsed.city, countryId, client)
        : null;

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