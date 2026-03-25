/**
 * normalizeKeywords.js
 * 
 * Creates a keyword_translations lookup table and batch-translates
 * high-frequency non-English keywords to English for unified analytics.
 * 
 * Approach:
 *   1. Find all distinct non-English keywords with >= N occurrences
 *   2. Translate them to English (batched)
 *   3. Store in keyword_translations table
 *   4. Analytics queries can JOIN to get normalized keyword
 * 
 * Usage:
 *   node normalizeKeywords.js --setup         # Create table
 *   node normalizeKeywords.js --analyze       # Show what needs translation
 *   node normalizeKeywords.js --translate     # Run translation batches
 *   node normalizeKeywords.js --backfill      # Update article_keywords with normalized_keyword
 */

'use strict';

require('dotenv').config();
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SETUP       = process.argv.includes('--setup');
const ANALYZE     = process.argv.includes('--analyze');
const TRANSLATE   = process.argv.includes('--translate');
const BACKFILL    = process.argv.includes('--backfill');

// ─── Config ────────────────────────────────────────────────────────────────
const CAP_ARG  = process.argv.indexOf('--cap');
const CHAR_CAP = CAP_ARG !== -1 ? parseInt(process.argv[CAP_ARG + 1]) : 250_000;

const CONFIG = {
  // Only translate keywords appearing in at least N articles
  MIN_OCCURRENCES: 5,

  // Batch size for translation API calls
  BATCH_SIZE: 50,

  // Pause between batches (ms) to avoid rate limits
  BATCH_PAUSE_MS: 1000,

  // Hard cap on DeepL characters sent per run (safety valve)
  CHAR_CAP,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Setup ─────────────────────────────────────────────────────────────────

async function setup() {
  console.log('Setting up keyword_translations table...');
  
  // Create table only if it doesn't exist (preserve existing data)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_translations (
      id SERIAL PRIMARY KEY,
      original_keyword TEXT NOT NULL UNIQUE,
      source_language TEXT DEFAULT 'auto',
      normalized_keyword TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_kt_original ON keyword_translations(original_keyword);
    CREATE INDEX IF NOT EXISTS idx_kt_normalized ON keyword_translations(normalized_keyword);
    CREATE INDEX IF NOT EXISTS idx_kt_lang ON keyword_translations(source_language);
  `);
  
  // Add normalized_keyword column to article_keywords if not exists
  await pool.query(`
    ALTER TABLE article_keywords 
    ADD COLUMN IF NOT EXISTS normalized_keyword TEXT
  `);
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ak_normalized ON article_keywords(normalized_keyword)
  `);
  
  console.log('Done. Tables and indexes created.');
}

// ─── Analyze ───────────────────────────────────────────────────────────────

async function analyze() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  KEYWORD LANGUAGE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get stats from keyword_daily_stats (aggregated, faster)
  console.log('Loading keyword stats...');
  const { rows: allKeywords } = await pool.query(`
    SELECT keyword, SUM(total_count)::integer AS mentions
    FROM keyword_daily_stats
    WHERE source_country_id IS NULL AND about_country_id IS NULL
    GROUP BY keyword
    HAVING SUM(total_count) >= $1
  `, [CONFIG.MIN_OCCURRENCES]);
  
  // Filter in JS
  const nonAsciiRegex = /[^\x00-\x7F]/;
  const nonAscii = allKeywords.filter(r => nonAsciiRegex.test(r.keyword));
  const ascii = allKeywords.filter(r => !nonAsciiRegex.test(r.keyword));

  console.log(`Total keywords (>= ${CONFIG.MIN_OCCURRENCES} mentions): ${allKeywords.length.toLocaleString()}`);
  console.log(`  ASCII (English/numbers):  ${ascii.length.toLocaleString()}`);
  console.log(`  Non-ASCII (to translate): ${nonAscii.length.toLocaleString()}`);

  // Already translated
  const { rows: [alreadyDone] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM keyword_translations
  `);
  console.log(`\nAlready translated: ${parseInt(alreadyDone.cnt).toLocaleString()}`);
  console.log(`Remaining to translate: ${Math.max(0, nonAscii.length - parseInt(alreadyDone.cnt)).toLocaleString()}`);

  // Sample non-ASCII keywords (already in memory, just sort/slice)
  console.log('\n── Top non-ASCII keywords ──────────────────────────────────\n');
  const samples = nonAscii.sort((a, b) => b.mentions - a.mentions).slice(0, 20);
  for (const r of samples) {
    console.log(`  "${r.keyword}" - ${r.mentions.toLocaleString()} mentions`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════\n');
}

// ─── Translate ─────────────────────────────────────────────────────────────

async function translateKeywords() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TRANSLATING KEYWORDS (high-frequency first)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get already translated keywords
  console.log('Loading already-translated keywords...');
  const { rows: doneRows } = await pool.query(`SELECT original_keyword FROM keyword_translations`);
  const doneSet = new Set(doneRows.map(r => r.original_keyword));
  console.log(`  Already translated: ${doneSet.size.toLocaleString()}`);

  // Get all non-ASCII keywords with counts, ordered by frequency
  console.log('Loading keywords by frequency...');
  const nonAsciiRegex = /[^\x00-\x7F]/;
  const MIN_KEYWORD_LENGTH = 3;
  
  const { rows: allKeywords } = await pool.query(`
    SELECT keyword, SUM(total_count)::integer AS mentions
    FROM keyword_daily_stats
    GROUP BY keyword
    HAVING SUM(total_count) >= $1
    ORDER BY SUM(total_count) DESC
  `, [CONFIG.MIN_OCCURRENCES]);

  // Filter: non-ASCII, min length, not already done
  const toTranslate = allKeywords.filter(r =>
    r.keyword.length >= MIN_KEYWORD_LENGTH &&
    nonAsciiRegex.test(r.keyword) &&
    !doneSet.has(r.keyword)
  );

  console.log(`  Total high-frequency keywords: ${allKeywords.length.toLocaleString()}`);
  // Apply character cap
  let charCount = 0;
  const capped = [];
  for (const row of toTranslate) {
    if (charCount + row.keyword.length > CONFIG.CHAR_CAP) break;
    capped.push(row);
    charCount += row.keyword.length;
  }
  const skipped = toTranslate.length - capped.length;

  // No character cap needed — Claude Haiku has no per-character billing.
  // Process all keywords in batches of 60.
  console.log(`  To normalize: ${toTranslate.length.toLocaleString()} keywords`);
  console.log('\nNormalizing via Claude Haiku (highest frequency first)...\n');

  const CLAUDE_BATCH = 60;
  let translated = 0;
  let errors = 0;
  let batchNum = 0;
  const totalBatches = Math.ceil(toTranslate.length / CLAUDE_BATCH);

  for (let i = 0; i < toTranslate.length; i += CLAUDE_BATCH) {
    batchNum++;
    const batch = toTranslate.slice(i, i + CLAUDE_BATCH);
    const keywords = batch.map(r => r.keyword);

    try {
      const msg = await aiClient.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Translate these news keywords/phrases to standard English equivalents for keyword indexing.
Return ONLY a valid JSON object: each key is the original keyword, each value is the lowercase English equivalent string, or null if untranslatable/too ambiguous/single character.
Use standard English proper nouns (e.g. "Пекин"→"beijing", "北京"→"beijing", "موسكو"→"moscow").

Keywords: ${JSON.stringify(keywords)}

JSON only:`
        }]
      });

      let map;
      try { map = JSON.parse(msg.content[0].text.trim()); }
      catch (parseErr) {
        errors += batch.length;
        console.warn(`  Batch ${batchNum}: JSON parse failed — ${parseErr.message}`);
        continue;
      }

      const entries = Object.entries(map).filter(([, v]) => v && typeof v === 'string' && v.trim());
      if (entries.length) {
        const vals   = entries.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',');
        const params = entries.flatMap(([orig, norm]) => [orig, norm.toLowerCase().trim()]);
        await pool.query(
          `INSERT INTO keyword_translations (original_keyword, normalized_keyword)
           VALUES ${vals} ON CONFLICT (original_keyword) DO NOTHING`,
          params
        );
        translated += entries.length;
      }

      const pct = ((batchNum / totalBatches) * 100).toFixed(0);
      const sample = entries.slice(0, 2).map(([k, v]) => `"${k}"→"${v}"`).join(', ');
      console.log(`  Batch ${batchNum}/${totalBatches} (${pct}%) — ${entries.length} normalized. e.g. ${sample}`);

    } catch (err) {
      errors += batch.length;
      console.warn(`  Batch ${batchNum}: API error — ${err.message}`);
    }

    // Small pause between batches to be polite to the API
    if (batchNum % 5 === 0) await sleep(500);
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Normalized: ${translated.toLocaleString()}`);
  console.log(`Errors:     ${errors.toLocaleString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

// ─── Backfill ──────────────────────────────────────────────────────────────

async function backfill() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BACKFILLING NORMALIZED KEYWORDS (batched)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const BATCH_SIZE = 10000;

  // Get ID range
  const { rows: [range] } = await pool.query(`
    SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM article_keywords
  `);
  const minId = parseInt(range.min_id) || 0;
  const maxId = parseInt(range.max_id) || 0;
  console.log(`ID range: ${minId.toLocaleString()} - ${maxId.toLocaleString()}`);

  let totalUpdated = 0;
  let currentId = minId;

  // Step 1: English keywords (batched by ID range)
  console.log('\n[1/3] Setting normalized_keyword = keyword for English...');
  currentId = minId;
  while (currentId <= maxId) {
    const endId = currentId + BATCH_SIZE;
    const { rowCount } = await pool.query(`
      UPDATE article_keywords
      SET normalized_keyword = LOWER(keyword)
      WHERE id >= $1 AND id < $2
        AND source_language = 'en' 
        AND normalized_keyword IS NULL
    `, [currentId, endId]);
    totalUpdated += rowCount;
    process.stdout.write(`  Progress: ${Math.min(currentId, maxId).toLocaleString()} / ${maxId.toLocaleString()} (updated: ${totalUpdated.toLocaleString()})\r`);
    currentId = endId;
  }
  console.log(`\n  English done: ${totalUpdated.toLocaleString()} rows`);

  // Step 2: Non-English with translations (batched)
  console.log('\n[2/3] Applying translations to non-English keywords...');
  let transUpdated = 0;
  currentId = minId;
  while (currentId <= maxId) {
    const endId = currentId + BATCH_SIZE;
    const { rowCount } = await pool.query(`
      UPDATE article_keywords ak
      SET normalized_keyword = kt.normalized_keyword
      FROM keyword_translations kt
      WHERE ak.id >= $1 AND ak.id < $2
        AND ak.keyword = kt.original_keyword
        AND ak.normalized_keyword IS NULL
    `, [currentId, endId]);
    transUpdated += rowCount;
    process.stdout.write(`  Progress: ${Math.min(currentId, maxId).toLocaleString()} / ${maxId.toLocaleString()} (updated: ${transUpdated.toLocaleString()})\r`);
    currentId = endId;
  }
  console.log(`\n  Translations applied: ${transUpdated.toLocaleString()} rows`);

  // Step 3: Remaining ASCII keywords (batched)
  console.log('\n[3/3] Lowercasing remaining ASCII keywords...');
  let asciiUpdated = 0;
  currentId = minId;
  while (currentId <= maxId) {
    const endId = currentId + BATCH_SIZE;
    const { rowCount } = await pool.query(`
      UPDATE article_keywords
      SET normalized_keyword = LOWER(keyword)
      WHERE id >= $1 AND id < $2
        AND normalized_keyword IS NULL
        AND keyword ~ '^[\\x00-\\x7F]+$'
    `, [currentId, endId]);
    asciiUpdated += rowCount;
    process.stdout.write(`  Progress: ${Math.min(currentId, maxId).toLocaleString()} / ${maxId.toLocaleString()} (updated: ${asciiUpdated.toLocaleString()})\r`);
    currentId = endId;
  }
  console.log(`\n  ASCII done: ${asciiUpdated.toLocaleString()} rows`);

  // Stats
  const { rows: [stats] } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE normalized_keyword IS NOT NULL) AS has_normalized,
      COUNT(*) FILTER (WHERE normalized_keyword IS NULL) AS missing_normalized,
      COUNT(*) AS total
    FROM article_keywords
  `);
  
  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Normalized:   ${parseInt(stats.has_normalized).toLocaleString()} rows`);
  console.log(`Still NULL:   ${parseInt(stats.missing_normalized).toLocaleString()} rows`);
  console.log(`Total:        ${parseInt(stats.total).toLocaleString()} rows`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    if (!SETUP && !ANALYZE && !TRANSLATE && !BACKFILL) {
      console.log('Usage:');
      console.log('  node normalizeKeywords.js --setup       # Create tables/indexes');
      console.log('  node normalizeKeywords.js --analyze     # Show language stats');
      console.log('  node normalizeKeywords.js --translate   # Translate non-English keywords');
      console.log('  node normalizeKeywords.js --backfill    # Update article_keywords.normalized_keyword');
      process.exit(0);
    }

    if (SETUP) await setup();
    if (ANALYZE) await analyze();
    if (TRANSLATE) await translateKeywords();
    if (BACKFILL) await backfill();

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();