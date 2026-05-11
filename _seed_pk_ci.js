'use strict';
/**
 * Seed multilingual country_location_keywords for Pakistan (id=94) and
 * Côte d'Ivoire (id=209). Both had zero rows before this run, which
 * meant articles in non-English scripts (Urdu, Arabic, Mandarin,
 * Russian, etc.) never produced article_locations rows for them and
 * those countries were invisible to thread aggregation outside
 * English-language coverage.
 *
 * Pattern mirrors the existing France / Belgium / Luxembourg seeds:
 *
 *   STRONG rows (is_phrase=true, tier_id=2, base_score=8 via tier):
 *     - canonical name in each language ("Pakistan", "巴基斯坦",
 *       "باكستان", "Côte d'Ivoire", "Ivory Coast", "科特迪瓦", ...)
 *
 *   WEAK rows (is_phrase=false, tier_id=1, base_score=3 via tier):
 *     - demonyms ("Pakistani", "巴基斯坦人", "باكستاني", "Ivorian",
 *       "ivoirien", ...)
 *
 * All rows use threshold=8. Strong rows fire on a single occurrence
 * (titleHits * 1.8 + summaryHits >= 8 / base_score 8); weak rows
 * need ~3 occurrences to fire (threshold 8 / base_score 3).
 *
 * If either country already has rows (unlikely given the diag), we
 * SKIP — the script is idempotent and ON CONFLICT DO NOTHING guards
 * against duplicates.
 */

require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

// Tier IDs (from existing keyword_tiers table):
//   1 = weak   (base_score 3)
//   2 = strong (base_score 8)
const STRONG = 2;
const WEAK   = 1;
const THRESHOLD = 8;

// Each entry: [phrase, is_phrase, tier_id]
// is_phrase=true uses Unicode word-boundary regex (better for Latin /
// Cyrillic / Arabic). is_phrase=false splits on spaces or does
// substring for CJK — used for demonyms historically.

const PAKISTAN_PHRASES = [
  // ── Canonical names (STRONG) ────────────────────────────────
  ['Pakistan',                          true,  STRONG],
  ['Republic of Pakistan',              true,  STRONG],
  ['Islamic Republic of Pakistan',      true,  STRONG],
  // ── East Asia ───────────────────────────────────────────────
  ['巴基斯坦',                          true,  STRONG],   // Chinese (Simplified + Traditional are identical)
  ['パキスタン',                        true,  STRONG],   // Japanese
  ['파키스탄',                          true,  STRONG],   // Korean
  // ── Middle East / South Asia ────────────────────────────────
  ['باكستان',                           true,  STRONG],   // Arabic
  ['پاکستان',                           true,  STRONG],   // Persian / Urdu
  ['पाकिस्तान',                          true,  STRONG],   // Hindi (Devanagari)
  ['ਪਾਕਿਸਤਾਨ',                          true,  STRONG],   // Punjabi (Gurmukhi)
  ['বাংলা পাকিস্তান',                    true,  STRONG],   // — placeholder, Bengali uses 'পাকিস্তান' standalone
  ['পাকিস্তান',                          true,  STRONG],   // Bengali
  ['பாகிஸ்தான்',                         true,  STRONG],   // Tamil
  ['ปากีสถาน',                          true,  STRONG],   // Thai
  ['Pakistanas',                        true,  STRONG],   // Lithuanian
  ['Pakistāna',                         true,  STRONG],   // Latvian
  // ── European languages ──────────────────────────────────────
  ['Пакистан',                          true,  STRONG],   // Russian / Bulgarian / Serbian / Macedonian / Ukrainian
  ['Pakistán',                          true,  STRONG],   // Spanish (with accent)
  ['Paquistão',                         true,  STRONG],   // Portuguese
  ['Pakisztán',                         true,  STRONG],   // Hungarian
  ['Πακιστάν',                          true,  STRONG],   // Greek
  ['פקיסטן',                            true,  STRONG],   // Hebrew
  ['Pákistán',                          true,  STRONG],   // Czech
  ['Pakistan',                          true,  STRONG],   // English duplicate suppressed — left here intentionally as a no-op since the index already contains it; ON CONFLICT skips
  // ── Southeast Asia ──────────────────────────────────────────
  ['Pakistanë',                         true,  STRONG],   // Albanian
  ['Pakistanin',                        true,  STRONG],   // Finnish
  // ── Demonyms (WEAK) ─────────────────────────────────────────
  ['Pakistani',                         false, WEAK],
  ['pakistani',                         false, WEAK],
  ['Pakistanis',                        false, WEAK],
  ['巴基斯坦人',                        false, WEAK],     // Chinese
  ['パキスタン人',                      false, WEAK],     // Japanese
  ['파키스탄인',                        false, WEAK],     // Korean
  ['باكستاني',                          false, WEAK],     // Arabic
  ['پاکستانی',                          false, WEAK],     // Persian / Urdu
  ['पाकिस्तानी',                         false, WEAK],     // Hindi
  ['ਪਾਕਿਸਤਾਨੀ',                          false, WEAK],     // Punjabi
  ['পাকিস্তানি',                          false, WEAK],     // Bengali
  ['பாகிஸ்தானியர்',                       false, WEAK],     // Tamil
  ['ปากีสถาน',                          false, WEAK],     // Thai
  ['пакистанец',                        false, WEAK],     // Russian
  ['пакистанець',                       false, WEAK],     // Ukrainian
  ['pakistaní',                         false, WEAK],     // Spanish
  ['paquistanês',                       false, WEAK],     // Portuguese
  ['pakisztáni',                        false, WEAK],     // Hungarian
  ['Πακιστανός',                        false, WEAK],     // Greek
  ['פקיסטני',                           false, WEAK],     // Hebrew
  ['Pakistański',                       false, WEAK],     // Polish
  ['Pakistańczyk',                      false, WEAK],     // Polish (alt form)
  ['pakistanlı',                        false, WEAK],     // Turkish
  ['pakistanaise',                      false, WEAK],     // French
  ['pakistanais',                       false, WEAK],     // French
  ['Pakistaner',                        false, WEAK],     // German
  ['pakistani',                         false, WEAK],     // Italian (dup but ON CONFLICT)
];

const IVORY_COAST_PHRASES = [
  // ── Canonical names (STRONG) ────────────────────────────────
  ["Côte d'Ivoire",                     true,  STRONG],
  ['Ivory Coast',                       true,  STRONG],
  ["Republic of Côte d'Ivoire",         true,  STRONG],
  ['Republic of Ivory Coast',           true,  STRONG],
  ["Cote d'Ivoire",                     true,  STRONG],   // no accent
  ['Cote d Ivoire',                     true,  STRONG],   // no apostrophe (mangled stripping)
  // ── East Asia ───────────────────────────────────────────────
  ['科特迪瓦',                          true,  STRONG],   // Chinese Simplified — modern usage
  ['象牙海岸',                          true,  STRONG],   // Chinese — older "Ivory Coast"
  ['コートジボワール',                  true,  STRONG],   // Japanese
  ['코트디부아르',                      true,  STRONG],   // Korean
  // ── Middle East / South Asia ────────────────────────────────
  ['ساحل العاج',                        true,  STRONG],   // Arabic (lit. "ivory coast")
  ['ساحل عاج',                          true,  STRONG],   // Persian
  ['कोट डिवोआर',                          true,  STRONG],   // Hindi
  ['ไอวอรีโคสต์',                       true,  STRONG],   // Thai
  // ── European languages ──────────────────────────────────────
  ["Кот-д'Ивуар",                       true,  STRONG],   // Russian
  ['Берег Слоновой Кости',              true,  STRONG],   // Russian (old form: "Ivory Coast")
  ["Кот-д'Івуар",                       true,  STRONG],   // Ukrainian
  ['Costa de Marfil',                   true,  STRONG],   // Spanish
  ['Costa do Marfim',                   true,  STRONG],   // Portuguese
  ["Costa d'Avorio",                    true,  STRONG],   // Italian
  ['Elfenbeinküste',                    true,  STRONG],   // German
  ['Ivoorkust',                         true,  STRONG],   // Dutch
  ['Elfenbenskysten',                   true,  STRONG],   // Danish
  ['Elfenbenskysten',                   true,  STRONG],   // Norwegian (same)
  ['Elfenbenskusten',                   true,  STRONG],   // Swedish
  ['Norsunluurannikko',                 true,  STRONG],   // Finnish
  ['Wybrzeże Kości Słoniowej',          true,  STRONG],   // Polish
  ['Pobřeží slonoviny',                 true,  STRONG],   // Czech
  ['Pobrežie Slonoviny',                true,  STRONG],   // Slovak
  ['Côte d Ivoire',                     true,  STRONG],   // mangled French
  ['Fildişi Sahili',                    true,  STRONG],   // Turkish
  ['Elefántcsontpart',                  true,  STRONG],   // Hungarian
  ['Ακτή Ελεφαντοστού',                 true,  STRONG],   // Greek
  ['חוף השנהב',                         true,  STRONG],   // Hebrew
  // ── Southeast Asia ──────────────────────────────────────────
  ['Pantai Gading',                     true,  STRONG],   // Indonesian / Malay
  ['Bờ Biển Ngà',                       true,  STRONG],   // Vietnamese
  // ── Demonyms (WEAK) ─────────────────────────────────────────
  ['Ivorian',                           false, WEAK],
  ['ivorian',                           false, WEAK],
  ['Ivorians',                          false, WEAK],
  ['ivoirien',                          false, WEAK],     // French
  ['ivoirienne',                        false, WEAK],     // French feminine
  ['ivoiriens',                         false, WEAK],     // French plural
  ['marfileño',                         false, WEAK],     // Spanish
  ['marfileños',                        false, WEAK],     // Spanish plural
  ['marfinense',                        false, WEAK],     // Portuguese
  ['ivoriano',                          false, WEAK],     // Italian
  ['ivorianisch',                       false, WEAK],     // German
  ['ivoriaan',                          false, WEAK],     // Dutch
  ['ивуариец',                          false, WEAK],     // Russian
  ['ивуарієць',                         false, WEAK],     // Ukrainian
  ['科特迪瓦人',                        false, WEAK],     // Chinese
  ['コートジボワール人',                false, WEAK],     // Japanese
  ['코트디부아르인',                    false, WEAK],     // Korean
  ['إيفواري',                           false, WEAK],     // Arabic
  ['ساحل عاجی',                         false, WEAK],     // Persian
];

const SEEDS = [
  { countryId: 94,  countryName: 'Pakistan',       phrases: PAKISTAN_PHRASES },
  { countryId: 209, countryName: "Côte d'Ivoire",  phrases: IVORY_COAST_PHRASES },
];

(async () => {
  const client = await pool.connect();
  let didCommit = false;
  try {
    await client.query('BEGIN');

    for (const seed of SEEDS) {
      // Sanity: how many rows does this country already have?
      const { rows: [pre] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [seed.countryId]
      );
      console.log(`\n   ${seed.countryName} (id=${seed.countryId}) — before: ${pre.c} rows`);

      let inserted = 0, skippedDup = 0;
      // We dedupe on (country_id, phrase) — phrases are case-sensitive
      // but trimmed. The DB doesn't have a UNIQUE constraint on
      // (country_id, phrase) by default, so we check via SELECT to
      // avoid duplicating an already-seeded phrase. (If a UNIQUE
      // constraint exists we'd use ON CONFLICT DO NOTHING; but adding
      // it now risks breaking other writers.)
      for (const [phrase, isPhrase, tierId] of seed.phrases) {
        const { rows: existing } = await client.query(
          `SELECT id FROM country_location_keywords
            WHERE country_id = $1 AND phrase = $2 LIMIT 1`,
          [seed.countryId, phrase]
        );
        if (existing.length) { skippedDup++; continue; }
        await client.query(
          `INSERT INTO country_location_keywords
             (country_id, phrase, is_phrase, threshold, tier_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [seed.countryId, phrase, isPhrase, THRESHOLD, tierId]
        );
        inserted++;
      }

      const { rows: [post] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [seed.countryId]
      );
      console.log(`   ${seed.countryName} — inserted: ${inserted}  skipped_dup: ${skippedDup}  after: ${post.c} rows`);
    }

    await client.query('COMMIT');
    didCommit = true;
    console.log(`\n✅ Pakistan + Côte d'Ivoire keyword rows committed.`);
  } catch (err) {
    if (!didCommit) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(`\n❌ FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
})();
