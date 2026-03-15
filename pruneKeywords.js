/**
 * pruneKeywords.js
 * 
 * Analyzes and prunes the article_keywords table to reduce bloat.
 * 
 * Usage:
 *   node pruneKeywords.js --analyze          (show stats, no changes)
 *   node pruneKeywords.js --prune            (delete low-value keywords)
 *   node pruneKeywords.js --prune --vacuum   (also run VACUUM ANALYZE after)
 */

'use strict';

require('dotenv').config();
const pool = require('./db');

const ANALYZE_ONLY = process.argv.includes('--analyze');
const DO_PRUNE     = process.argv.includes('--prune');
const DO_VACUUM    = process.argv.includes('--vacuum');

// ─── Pruning thresholds ────────────────────────────────────────────────────
const CONFIG = {
  // Delete keywords that appear in fewer than N articles globally
  MIN_GLOBAL_OCCURRENCES: 2,
  
  // Delete keywords with frequency score <= N (within-article score)
  MIN_FREQUENCY_SCORE: 1,
  
  // Delete keywords shorter than N characters (catches noise like "the", "and")
  MIN_KEYWORD_LENGTH: 3,
  
  // Keep only top N keywords per article (by frequency)
  MAX_KEYWORDS_PER_ARTICLE: 15,
  
  // Delete pure numeric keywords (e.g., "2024", "100")
  DELETE_NUMERIC: true,
  
  // Batch size for deletes
  BATCH_SIZE: 10000,
};

async function analyze() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  KEYWORD TABLE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Total rows and size
  const { rows: sizeRows } = await pool.query(`
    SELECT 
      COUNT(*) AS total_rows,
      pg_size_pretty(pg_total_relation_size('article_keywords')) AS total_size,
      pg_total_relation_size('article_keywords') AS size_bytes
    FROM article_keywords
  `);
  console.log(`Total rows:        ${parseInt(sizeRows[0].total_rows).toLocaleString()}`);
  console.log(`Total size:        ${sizeRows[0].total_size}`);
  
  // Unique keywords
  const { rows: uniqueRows } = await pool.query(`
    SELECT COUNT(DISTINCT keyword) AS unique_keywords FROM article_keywords
  `);
  console.log(`Unique keywords:   ${parseInt(uniqueRows[0].unique_keywords).toLocaleString()}`);

  // Distribution by global occurrence count
  console.log('\n── Distribution by global occurrences ──────────────────────\n');
  const { rows: distRows } = await pool.query(`
    WITH keyword_counts AS (
      SELECT keyword, COUNT(*) AS occurrences
      FROM article_keywords
      GROUP BY keyword
    )
    SELECT 
      CASE 
        WHEN occurrences = 1 THEN '1 (singleton)'
        WHEN occurrences = 2 THEN '2'
        WHEN occurrences BETWEEN 3 AND 5 THEN '3-5'
        WHEN occurrences BETWEEN 6 AND 10 THEN '6-10'
        WHEN occurrences BETWEEN 11 AND 50 THEN '11-50'
        WHEN occurrences BETWEEN 51 AND 100 THEN '51-100'
        ELSE '100+'
      END AS bucket,
      COUNT(*) AS unique_keywords,
      SUM(occurrences) AS total_rows
    FROM keyword_counts
    GROUP BY 1
    ORDER BY MIN(occurrences)
  `);
  
  console.log('Bucket           Unique Keywords    Total Rows');
  console.log('─────────────────────────────────────────────────');
  for (const r of distRows) {
    console.log(`${r.bucket.padEnd(16)} ${parseInt(r.unique_keywords).toLocaleString().padStart(15)}    ${parseInt(r.total_rows).toLocaleString().padStart(12)}`);
  }

  // Rows that would be deleted by each rule
  console.log('\n── Pruning impact (rows that would be deleted) ─────────────\n');

  const { rows: [r1] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM article_keywords
    WHERE keyword IN (
      SELECT keyword FROM article_keywords GROUP BY keyword HAVING COUNT(*) < $1
    )
  `, [CONFIG.MIN_GLOBAL_OCCURRENCES]);
  console.log(`Global occurrences < ${CONFIG.MIN_GLOBAL_OCCURRENCES}:    ${parseInt(r1.cnt).toLocaleString()} rows`);

  const { rows: [r2] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM article_keywords WHERE frequency <= $1
  `, [CONFIG.MIN_FREQUENCY_SCORE]);
  console.log(`Frequency score <= ${CONFIG.MIN_FREQUENCY_SCORE}:       ${parseInt(r2.cnt).toLocaleString()} rows`);

  const { rows: [r3] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM article_keywords WHERE LENGTH(keyword) < $1
  `, [CONFIG.MIN_KEYWORD_LENGTH]);
  console.log(`Length < ${CONFIG.MIN_KEYWORD_LENGTH} chars:            ${parseInt(r3.cnt).toLocaleString()} rows`);

  const { rows: [r4] } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM article_keywords WHERE keyword ~ '^[0-9]+$'
  `);
  console.log(`Pure numeric:              ${parseInt(r4.cnt).toLocaleString()} rows`);

  const { rows: [r5] } = await pool.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY frequency DESC) AS rn
      FROM article_keywords
    )
    SELECT COUNT(*) AS cnt FROM ranked WHERE rn > $1
  `, [CONFIG.MAX_KEYWORDS_PER_ARTICLE]);
  console.log(`Beyond top ${CONFIG.MAX_KEYWORDS_PER_ARTICLE} per article:   ${parseInt(r5.cnt).toLocaleString()} rows`);

  // Language distribution
  console.log('\n── Language distribution ───────────────────────────────────\n');
  const { rows: langRows } = await pool.query(`
    SELECT source_language, COUNT(*) AS cnt
    FROM article_keywords
    GROUP BY source_language
    ORDER BY cnt DESC
    LIMIT 15
  `);
  for (const r of langRows) {
    console.log(`  ${(r.source_language || 'NULL').padEnd(6)} ${parseInt(r.cnt).toLocaleString().padStart(12)} rows`);
  }

  // Sample singletons (keywords appearing only once)
  console.log('\n── Sample singleton keywords (noise) ───────────────────────\n');
  const { rows: singletonSamples } = await pool.query(`
    SELECT keyword, source_language
    FROM article_keywords
    WHERE keyword IN (
      SELECT keyword FROM article_keywords GROUP BY keyword HAVING COUNT(*) = 1
    )
    ORDER BY RANDOM()
    LIMIT 20
  `);
  for (const r of singletonSamples) {
    console.log(`  "${r.keyword}" (${r.source_language})`);
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');
}

async function prune() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PRUNING KEYWORDS');
  console.log('═══════════════════════════════════════════════════════════\n');

  let totalDeleted = 0;

  // 1. Delete pure numeric keywords
  if (CONFIG.DELETE_NUMERIC) {
    console.log('Deleting pure numeric keywords...');
    const { rowCount } = await pool.query(`
      DELETE FROM article_keywords WHERE keyword ~ '^[0-9]+$'
    `);
    console.log(`  Deleted: ${rowCount.toLocaleString()} rows`);
    totalDeleted += rowCount;
  }

  // 2. Delete short keywords
  console.log(`\nDeleting keywords shorter than ${CONFIG.MIN_KEYWORD_LENGTH} chars...`);
  const { rowCount: rc2 } = await pool.query(`
    DELETE FROM article_keywords WHERE LENGTH(keyword) < $1
  `, [CONFIG.MIN_KEYWORD_LENGTH]);
  console.log(`  Deleted: ${rc2.toLocaleString()} rows`);
  totalDeleted += rc2;

  // 3. Delete low frequency keywords
  console.log(`\nDeleting keywords with frequency <= ${CONFIG.MIN_FREQUENCY_SCORE}...`);
  const { rowCount: rc3 } = await pool.query(`
    DELETE FROM article_keywords WHERE frequency <= $1
  `, [CONFIG.MIN_FREQUENCY_SCORE]);
  console.log(`  Deleted: ${rc3.toLocaleString()} rows`);
  totalDeleted += rc3;

  // 4. Delete singletons (keywords appearing in only 1 article)
  console.log(`\nDeleting keywords with < ${CONFIG.MIN_GLOBAL_OCCURRENCES} global occurrences...`);
  // Do this in batches to avoid long locks
  let batchDeleted = 0;
  while (true) {
    const { rowCount } = await pool.query(`
      DELETE FROM article_keywords
      WHERE id IN (
        SELECT ak.id
        FROM article_keywords ak
        JOIN (
          SELECT keyword
          FROM article_keywords
          GROUP BY keyword
          HAVING COUNT(*) < $1
          LIMIT $2
        ) low ON low.keyword = ak.keyword
      )
    `, [CONFIG.MIN_GLOBAL_OCCURRENCES, CONFIG.BATCH_SIZE]);
    
    if (rowCount === 0) break;
    batchDeleted += rowCount;
    process.stdout.write(`  Deleted: ${batchDeleted.toLocaleString()} rows...\r`);
  }
  console.log(`  Deleted: ${batchDeleted.toLocaleString()} rows`);
  totalDeleted += batchDeleted;

  // 5. Keep only top N per article
  console.log(`\nKeeping only top ${CONFIG.MAX_KEYWORDS_PER_ARTICLE} keywords per article...`);
  const { rowCount: rc5 } = await pool.query(`
    DELETE FROM article_keywords
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY frequency DESC) AS rn
        FROM article_keywords
      ) ranked
      WHERE rn > $1
    )
  `, [CONFIG.MAX_KEYWORDS_PER_ARTICLE]);
  console.log(`  Deleted: ${rc5.toLocaleString()} rows`);
  totalDeleted += rc5;

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`TOTAL DELETED: ${totalDeleted.toLocaleString()} rows`);

  if (DO_VACUUM) {
    console.log('\nRunning VACUUM ANALYZE (this may take a while)...');
    await pool.query('VACUUM ANALYZE article_keywords');
    console.log('Done.');
  } else {
    console.log('\nTip: Run with --vacuum to reclaim disk space');
  }

  // Show new size
  const { rows: sizeRows } = await pool.query(`
    SELECT 
      COUNT(*) AS total_rows,
      pg_size_pretty(pg_total_relation_size('article_keywords')) AS total_size
    FROM article_keywords
  `);
  console.log(`\nNew row count: ${parseInt(sizeRows[0].total_rows).toLocaleString()}`);
  console.log(`New size:      ${sizeRows[0].total_size} (run VACUUM to reclaim space)`);
  
  console.log('\n═══════════════════════════════════════════════════════════\n');
}

async function main() {
  try {
    if (!DO_PRUNE && !ANALYZE_ONLY) {
      console.log('Usage:');
      console.log('  node pruneKeywords.js --analyze        # Show stats only');
      console.log('  node pruneKeywords.js --prune          # Delete low-value keywords');
      console.log('  node pruneKeywords.js --prune --vacuum # Also reclaim disk space');
      process.exit(0);
    }

    if (ANALYZE_ONLY || DO_PRUNE) {
      await analyze();
    }

    if (DO_PRUNE) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      
      await new Promise(resolve => {
        rl.question('Proceed with pruning? (yes/no): ', answer => {
          rl.close();
          if (answer.toLowerCase() !== 'yes') {
            console.log('Aborted.');
            process.exit(0);
          }
          resolve();
        });
      });

      await prune();
    }

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();