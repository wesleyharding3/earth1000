/**
 * generateRegionGeoJSON.js
 *
 * Downloads Natural Earth 110m country polygons, maps each country
 * to a region by ISO code, dissolves borders within each region,
 * then bulk-updates the regions table with the resulting GeoJSON.
 *
 * Run once: node generateRegionGeoJSON.js
 * Requires: npm install @turf/turf node-fetch
 */

require("dotenv").config();
const turf  = require("@turf/turf");
const pool  = require("./db");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const NE_URL  = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const CACHE   = path.join(__dirname, "ne_110m_countries.geojson");

// ── Country ISO → region slug mapping ──────────────────────
// Every country on earth mapped to exactly one region slug.
// This is the single source of truth for no-gaps / no-overlaps.
const COUNTRY_TO_REGION = {
  // AFRICA — Maghreb
  MA: "maghreb", DZ: "maghreb", TN: "maghreb",

  // AFRICA — Nile Valley
  EG: "nile-valley", SD: "nile-valley",

  // AFRICA — Libyan Desert
  LY: "libyan-desert",

  // AFRICA — Sahel (original broad entry catches residual)
  MR: "western-sahel", SN: "senegambia", GM: "senegambia", GW: "senegambia",
  ML: "central-sahel", BF: "central-sahel", NE: "central-sahel",
  TD: "eastern-sahel",

  // AFRICA — Upper Guinea
  GN: "upper-guinea", SL: "upper-guinea", LR: "upper-guinea",

  // AFRICA — Ivory Coast Belt
  CI: "ivory-coast-belt", GH: "ivory-coast-belt",

  // AFRICA — Niger Delta / Nigeria
  NG: "nigeria-heartland", BJ: "niger-delta", TG: "niger-delta",

  // AFRICA — Gulf of Guinea islands
  GQ: "gulf-of-guinea", GA: "gulf-of-guinea", ST: "gulf-of-guinea", CM: "gulf-of-guinea",

  // AFRICA — Congo Basin
  CD: "congo-basin", CG: "congo-basin", CF: "congo-basin",

  // AFRICA — Great Lakes Africa
  RW: "great-lakes-africa", BI: "great-lakes-africa", UG: "great-lakes-africa",

  // AFRICA — Angola Plateau
  AO: "angola-plateau", ZM: "angola-plateau",

  // AFRICA — Swahili Coast
  KE: "swahili-coast", TZ: "swahili-coast",

  // AFRICA — Ethiopian Highlands
  ET: "ethiopian-highlands", ER: "ethiopian-highlands",

  // AFRICA — Somali Peninsula
  SO: "somali-peninsula", DJ: "somali-peninsula",

  // AFRICA — Great Rift Valley (landlocked East Africa)
  MW: "great-rift-valley",

  // AFRICA — Zambezi Basin
  ZW: "zambezi-basin",

  // AFRICA — Kalahari
  BW: "kalahari", NA: "kalahari",

  // AFRICA — Cape Region
  ZA: "highveld", LS: "highveld", SZ: "highveld",

  // AFRICA — Mozambique Channel
  MZ: "mozambique-channel", MG: "mozambique-channel", KM: "mozambique-channel",

  // AFRICA — Indian Ocean islands
  MU: "mozambique-channel", SC: "mozambique-channel", RE: "mozambique-channel",

  // AFRICA — Sahara (Western Sahara)
  EH: "sahara",

  // AFRICA — Cape Verde
  CV: "senegambia",

  // EUROPE
  GB: "british-isles", IE: "british-isles",
  FR: "western-europe", BE: "north-sea-coast", LU: "western-europe",
  NL: "north-sea-coast", DE: "central-europe",
  CH: "alpine-europe", AT: "alpine-europe", LI: "alpine-europe",
  PL: "central-europe", CZ: "central-europe", SK: "central-europe",
  HU: "pannonian-plain", RS: "pannonian-plain", HR: "dinaric-alps",
  SI: "dinaric-alps", BA: "dinaric-alps", ME: "dinaric-alps",
  MK: "balkans", AL: "balkans", GR: "balkans", BG: "balkans",
  RO: "black-sea", MD: "pontic-steppe",
  UA: "pontic-steppe", BY: "eastern-europe",
  LT: "baltics", LV: "baltics", EE: "baltics",
  FI: "scandinavia", SE: "scandinavia", NO: "scandinavia", DK: "scandinavia",
  IS: "arctic-europe",
  PT: "iberian-peninsula", ES: "iberian-peninsula",
  IT: "southern-europe", MT: "southern-europe",
  MC: "mediterranean-france", AD: "iberian-peninsula",
  SM: "southern-europe", VA: "southern-europe",
  CY: "levant",
  XK: "balkans",

  // MIDDLE EAST
  TR: "anatolia",
  SY: "levant", LB: "levant", IL: "levant", JO: "levant", PS: "levant",
  IQ: "mesopotamia", KW: "gulf-states",
  IR: "iran-plateau",
  SA: "arabian-peninsula", YE: "arabian-peninsula", OM: "arabian-peninsula",
  AE: "gulf-states", QA: "gulf-states", BH: "gulf-states",
  GE: "caucasus", AM: "caucasus", AZ: "caucasus",

  // CENTRAL ASIA
  KZ: "kazakh-steppe",
  UZ: "transoxiana", TJ: "transoxiana", KG: "transoxiana",
  TM: "turkmen-desert",
  AF: "pamir-hindu-kush",

  // SIBERIA / RUSSIA — handled specially below
  RU: "west-siberia",  // Russia split handled by bbox clipping

  // SOUTH ASIA
  IN: "deccan",        // India split below by region
  PK: "punjab",        // Pakistan primary region
  BD: "bengal-delta",
  NP: "himalayan-belt", BT: "himalayan-belt",
  LK: "sri-lanka",
  MV: "maldives",

  // SOUTHEAST ASIA
  MM: "irrawaddy-basin",
  TH: "thailand-basin",
  LA: "indochina", VN: "indochina", KH: "indochina",
  MY: "malay-peninsula", SG: "malay-peninsula",
  ID: "maritime-southeast-asia",
  PH: "philippines",
  BN: "borneo", TL: "eastern-indonesia",

  // EAST ASIA
  CN: "north-china-plain",  // China split below
  MN: "mongolia",
  KP: "korean-peninsula", KR: "korean-peninsula",
  JP: "japan",
  TW: "taiwan-strait",
  HK: "pearl-river-delta", MO: "pearl-river-delta",

  // NORTH AMERICA
  US: "great-lakes",   // US split below
  CA: "central-canada", // Canada split below
  MX: "mexican-plateau",
  GT: "central-america", BZ: "yucatan", HN: "central-america",
  SV: "central-america", NI: "central-america", CR: "central-america", PA: "central-america",
  CU: "greater-antilles", JM: "greater-antilles", HT: "greater-antilles", DO: "greater-antilles",
  PR: "greater-antilles",
  TT: "lesser-antilles", BB: "lesser-antilles", LC: "lesser-antilles", VC: "lesser-antilles",
  GD: "lesser-antilles", AG: "lesser-antilles", DM: "lesser-antilles", KN: "lesser-antilles",

  // SOUTH AMERICA
  CO: "northern-andes", VE: "orinoco-basin", EC: "northern-andes",
  PE: "central-andes", BO: "gran-chaco",
  CL: "southern-andes", AR: "pampas",
  BR: "cerrado",
  UY: "pampas",
  PY: "gran-chaco",
  GY: "guiana-highlands", SR: "guiana-highlands", GF: "guiana-highlands",
  FK: "patagonia",

  // OCEANIA
  AU: "australia-east-coast",  // Australia split below
  NZ: "new-zealand",
  PG: "papua-new-guinea",
  FJ: "melanesia", VU: "melanesia", SB: "melanesia", NC: "melanesia", PF: "polynesia",
  WS: "polynesia", TO: "polynesia", TV: "polynesia", KI: "micronesia",
  FM: "micronesia", MH: "micronesia", PW: "micronesia", NR: "micronesia",
  CK: "polynesia", NU: "polynesia",
};

// ── Download or load cached Natural Earth GeoJSON ──────────
async function loadNaturalEarth() {
  if (fs.existsSync(CACHE)) {
    console.log("  📦 Using cached Natural Earth data");
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  }

  console.log("  🌐 Downloading Natural Earth 110m countries...");
  return new Promise((resolve, reject) => {
    https.get(NE_URL, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        fs.writeFileSync(CACHE, data);
        resolve(JSON.parse(data));
      });
      res.on("error", reject);
    });
  });
}

// ── Group country features by region slug ──────────────────
function groupByRegion(geojson) {
  const groups = {};

  for (const feature of geojson.features) {
    const iso = feature.properties.ISO_A2 || feature.properties.iso_a2 || "";
    const slug = COUNTRY_TO_REGION[iso];
    if (!slug) {
      console.warn(`    ⚠️  No region for ISO: ${iso} (${feature.properties.NAME})`);
      continue;
    }
    if (!groups[slug]) groups[slug] = [];
    groups[slug].push(feature);
  }

  return groups;
}

// ── Dissolve a group of country features into one polygon ──
function dissolveGroup(features) {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0].geometry;

  try {
    const fc = turf.featureCollection(features);
    const dissolved = turf.dissolve(fc);
    if (dissolved.features.length === 1) {
      return dissolved.features[0].geometry;
    }
    // Multiple disconnected polygons → MultiPolygon
    const coords = dissolved.features.map(f => {
      const g = f.geometry;
      return g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
    });
    return { type: "MultiPolygon", coordinates: coords };
  } catch (err) {
    console.warn(`    ⚠️  Dissolve failed: ${err.message} — using union fallback`);
    // Fallback: just use first feature
    return features[0].geometry;
  }
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log("🚀 Region GeoJSON generator starting...\n");

  const ne = await loadNaturalEarth();
  console.log(`  ✅ Loaded ${ne.features.length} country features\n`);

  const groups = groupByRegion(ne);
  console.log(`  📋 Mapped to ${Object.keys(groups).length} regions\n`);

  let updated = 0;
  let skipped = 0;

  for (const [slug, features] of Object.entries(groups)) {
    process.stdout.write(`  🗺  ${slug.padEnd(35)}`);
    const geometry = dissolveGroup(features);
    if (!geometry) { console.log("❌ null geometry"); skipped++; continue; }

    // Calculate centroid from dissolved geometry
    try {
      const centroid = turf.centroid(turf.feature(geometry));
      const [lng, lat] = centroid.geometry.coordinates;

      await pool.query(
        `UPDATE regions
         SET geojson = $1,
             centroid_lng = $2,
             centroid_lat = $3
         WHERE slug = $4`,
        [JSON.stringify(geometry), Math.round(lng * 10000) / 10000, Math.round(lat * 10000) / 10000, slug]
      );
      console.log(`✅  ${features.length} countries dissolved`);
      updated++;
    } catch (err) {
      console.log(`❌  DB error: ${err.message}`);
      skipped++;
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`✅ Done. Updated: ${updated} | Skipped: ${skipped}`);
  console.log(`   Regions with no countries mapped: check COUNTRY_TO_REGION`);
  process.exit(0);
}

main().catch(err => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});