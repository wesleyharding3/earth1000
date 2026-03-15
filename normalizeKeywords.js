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
const { translateText } = require('./translator');

const SETUP       = process.argv.includes('--setup');
const ANALYZE     = process.argv.includes('--analyze');
const TRANSLATE   = process.argv.includes('--translate');
const BACKFILL    = process.argv.includes('--backfill');

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  // Only translate keywords appearing in at least N articles
  MIN_OCCURRENCES: 5,
  
  // Batch size for translation API calls
  BATCH_SIZE: 50,
  
  // Pause between batches (ms) to avoid rate limits
  BATCH_PAUSE_MS: 1000,
  
  // Languages to translate (non-English)
  // These are the source languages we'll translate FROM
  TRANSLATE_LANGS: ['ar', 'ru', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'it', 'tr', 'pl', 'uk', 'nl', 'th', 'vi', 'id', 'he', 'fa', 'hi'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Setup ─────────────────────────────────────────────────────────────────

async function setup() {
  console.log('Creating keyword_translations table...');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_translations (
      id SERIAL PRIMARY KEY,
      original_keyword TEXT NOT NULL,
      source_language TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(original_keyword, source_language)
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

  // Language distribution
  const { rows: langRows } = await pool.query(`
    SELECT 
      source_language,
      COUNT(DISTINCT keyword) AS unique_keywords,
      COUNT(*) AS total_rows
    FROM article_keywords
    GROUP BY source_language
    ORDER BY total_rows DESC
  `);
  
  console.log('Language    Unique Keywords    Total Rows');
  console.log('─────────────────────────────────────────────');
  for (const r of langRows) {
    const lang = (r.source_language || 'NULL').padEnd(10);
    console.log(`${lang} ${parseInt(r.unique_keywords).toLocaleString().padStart(15)}    ${parseInt(r.total_rows).toLocaleString().padStart(12)}`);
  }

  // Non-English keywords needing translation
  console.log('\n── Keywords needing translation ────────────────────────────\n');
  
  const { rows: [needsTranslation] } = await pool.query(`
    SELECT COUNT(DISTINCT keyword) AS cnt
    FROM article_keywords
    WHERE source_language != 'en' 
      AND source_language IS NOT NULL
      AND source_language = ANY($1)
      AND keyword IN (
        SELECT keyword FROM article_keywords 
        GROUP BY keyword HAVING COUNT(*) >= $2
      )
  `, [CONFIG.TRANSLATE_LANGS, CONFIG.MIN_OCCURRENCES]);
  
  console.log(`Unique non-English keywords (>= ${CONFIG.MIN_OCCURRENCES} occurrences): ${parseInt(needsTranslation.cnt).toLocaleString()}`);

  // Already translated
  const { rows: [alreadyDone] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM keyword_translations
  `);
  console.log(`Already translated: ${parseInt(alreadyDone.cnt).toLocaleString()}`);

  // Sample non-English high-frequency keywords
  console.log('\n── Sample non-English keywords to translate ────────────────\n');
  const { rows: samples } = await pool.query(`
    SELECT keyword, source_language, COUNT(*) AS occurrences
    FROM article_keywords
    WHERE source_language != 'en' 
      AND source_language IS NOT NULL
      AND source_language = ANY($1)
    GROUP BY keyword, source_language
    HAVING COUNT(*) >= $2
    ORDER BY occurrences DESC
    LIMIT 20
  `, [CONFIG.TRANSLATE_LANGS, CONFIG.MIN_OCCURRENCES]);
  
  for (const r of samples) {
    console.log(`  "${r.keyword}" (${r.source_language}) - ${parseInt(r.occurrences).toLocaleString()} occurrences`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════\n');
}

// ─── Translate ─────────────────────────────────────────────────────────────

async function translateKeywords() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TRANSLATING KEYWORDS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get keywords that need translation (not already in keyword_translations)
  const { rows: toTranslate } = await pool.query(`
    SELECT DISTINCT ak.keyword, ak.source_language
    FROM article_keywords ak
    LEFT JOIN keyword_translations kt 
      ON kt.original_keyword = ak.keyword 
      AND kt.source_language = ak.source_language
    WHERE ak.source_language != 'en' 
      AND ak.source_language IS NOT NULL
      AND ak.source_language = ANY($1)
      AND kt.id IS NULL
      AND ak.keyword IN (
        SELECT keyword FROM article_keywords 
        GROUP BY keyword HAVING COUNT(*) >= $2
      )
    ORDER BY ak.source_language
  `, [CONFIG.TRANSLATE_LANGS, CONFIG.MIN_OCCURRENCES]);

  console.log(`Keywords to translate: ${toTranslate.length.toLocaleString()}`);
  
  if (toTranslate.length === 0) {
    console.log('Nothing to translate!');
    return;
  }

  let translated = 0;
  let errors = 0;
  
  // Process in batches by language
  const byLang = {};
  for (const row of toTranslate) {
    if (!byLang[row.source_language]) byLang[row.source_language] = [];
    byLang[row.source_language].push(row.keyword);
  }

  for (const [lang, keywords] of Object.entries(byLang)) {
    console.log(`\nTranslating ${keywords.length} ${lang} keywords...`);
    
    for (let i = 0; i < keywords.length; i += CONFIG.BATCH_SIZE) {
      const batch = keywords.slice(i, i + CONFIG.BATCH_SIZE);
      
      for (const keyword of batch) {
        try {
          // DeepL auto-detects source language, just specify target
          const normalized = await translateText(keyword, 'EN-US');
          
          if (normalized && normalized.trim()) {
            await pool.query(`
              INSERT INTO keyword_translations (original_keyword, source_language, normalized_keyword)
              VALUES ($1, $2, $3)
              ON CONFLICT (original_keyword, source_language) DO UPDATE
              SET normalized_keyword = EXCLUDED.normalized_keyword
            `, [keyword, lang, normalized.toLowerCase().trim()]);
            
            translated++;
          }
        } catch (err) {
          errors++;
          if (errors <= 5) {
            console.warn(`  Error translating "${keyword}": ${err.message}`);
          }
        }
      }
      
      process.stdout.write(`  Progress: ${Math.min(i + CONFIG.BATCH_SIZE, keywords.length)}/${keywords.length} (${translated} translated, ${errors} errors)\r`);
      
      if (i + CONFIG.BATCH_SIZE < keywords.length) {
        await sleep(CONFIG.BATCH_PAUSE_MS);
      }
    }
    console.log();
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Translated: ${translated.toLocaleString()}`);
  console.log(`Errors:     ${errors.toLocaleString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

// ─── Backfill ──────────────────────────────────────────────────────────────

async function backfill() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BACKFILLING NORMALIZED KEYWORDS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // For English keywords, normalized = original
  console.log('Setting normalized_keyword = keyword for English...');
  const { rowCount: enCount } = await pool.query(`
    UPDATE article_keywords
    SET normalized_keyword = LOWER(keyword)
    WHERE source_language = 'en' AND normalized_keyword IS NULL
  `);
  console.log(`  Updated: ${enCount.toLocaleString()} rows`);

  // For non-English, use translation table
  console.log('\nApplying translations to non-English keywords...');
  const { rowCount: transCount } = await pool.query(`
    UPDATE article_keywords ak
    SET normalized_keyword = kt.normalized_keyword
    FROM keyword_translations kt
    WHERE ak.keyword = kt.original_keyword
      AND ak.source_language = kt.source_language
      AND ak.normalized_keyword IS NULL
  `);
  console.log(`  Updated: ${transCount.toLocaleString()} rows`);

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