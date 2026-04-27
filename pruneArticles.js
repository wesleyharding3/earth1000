/**
 * pruneArticles.js
 *
 * Deletes old, low-value articles and their orphaned article_keywords rows.
 * "Low-value" = published by a source with popularity_score below a threshold
 * AND older than a configurable number of days.
 *
 * Usage:
 *   node pruneArticles.js --analyze                (show stats, no changes)
 *   node pruneArticles.js --prune                  (delete articles)
 *   node pruneArticles.js --prune --vacuum          (also VACUUM ANALYZE after)
 *   node pruneArticles.js --prune --days=120        (override age threshold)
 *   node pruneArticles.js --prune --score=2         (override score threshold)
 */

'use strict';

// Cap concurrent DB connections. Sequential aggregate + DELETE; 2 is sufficient.
process.env.DB_POOL_MAX = "2";

require('dotenv').config();
const pool = require('./db');

const ANALYZE_ONLY = process.argv.includes('--analyze');
const DO_PRUNE     = process.argv.includes('--prune');
const DO_VACUUM    = process.argv.includes('--vacuum');

// Parse --days=N and --score=N from CLI args
function parseArg(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split('=')[1], 10) : fallback;
}

const CONFIG = {
  // Articles older than this many days are candidates for deletion
  MIN_AGE_DAYS: parseArg('days', 90),

  // Only delete articles from sources with popularity_score <= this
  // Higher-value sources are preserved regardless of age
  MAX_SOURCE_SCORE: parseArg('score', 3),

  // Batch size for DELETE operations (avoid locking the whole table)
  BATCH_SIZE: 5000,
};

async function analyze() {
  console.log('\n📊 Article Table Analysis\n');

  // Total articles
  const { rows: [{ count: total }] } = await pool.query(
    'SELECT COUNT(*) AS count FROM articles'
  );
  console.log(`  Total articles: ${parseInt(total).toLocaleString()}`);

  // Table size
  const { rows: [sizeRow] } = await pool.query(`
    SELECT pg_size_pretty(pg_total_relation_size('articles')) AS total_size,
           pg_total_relation_size('articles') AS size_bytes
    FROM articles LIMIT 1
  `);
  console.log(`  Table size: ${sizeRow.total_size}`);

  // Age distribution
  const { rows: ageDist } = await pool.query(`
    SELECT
      CASE
        WHEN published_at >= NOW() - INTERVAL '7 days'  THEN '< 7 days'
        WHEN published_at >= NOW() - INTERVAL '30 days' THEN '7-30 days'
        WHEN published_at >= NOW() - INTERVAL '90 days' THEN '30-90 days'
        WHEN published_at >= NOW() - INTERVAL '180 days' THEN '90-180 days'
        ELSE '180+ days'
      END AS age_bucket,
      COUNT(*) AS cnt
    FROM articles
    GROUP BY 1
    ORDER BY MIN(published_at) DESC
  `);
  console.log('\n  Age distribution:');
  ageDist.forEach(r => console.log(`    ${r.age_bucket.padEnd(12)} ${parseInt(r.cnt).toLocaleString()}`));

  // Candidates for deletion (old + low-source-score)
  const { rows: [{ count: candidates }] } = await pool.query(`
    SELECT COUNT(*) AS count
    FROM articles a
    LEFT JOIN news_sources ns ON ns.id = a.source_id
    WHERE a.published_at < NOW() - ($1 || ' days')::interval
      AND COALESCE(ns.popularity_score, 0) <= $2
  `, [String(CONFIG.MIN_AGE_DAYS), CONFIG.MAX_SOURCE_SCORE]);
  console.log(`\n  Deletion candidates (>${CONFIG.MIN_AGE_DAYS} days old, source score ≤${CONFIG.MAX_SOURCE_SCORE}): ${parseInt(candidates).toLocaleString()}`);

  // Orphaned article_keywords (keywords referencing deleted articles)
  const { rows: [{ count: orphans }] } = await pool.query(`
    SELECT COUNT(*) AS count
    FROM article_keywords ak
    WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = ak.article_id)
  `);
  console.log(`  Orphaned article_keywords rows: ${parseInt(orphans).toLocaleString()}`);

  console.log('');
}

async function prune() {
  console.log(`\n🗑️  Pruning articles older than ${CONFIG.MIN_AGE_DAYS} days with source score ≤ ${CONFIG.MAX_SOURCE_SCORE}\n`);

  let totalDeleted = 0;

  // Delete in batches to avoid long locks
  while (true) {
    const { rowCount } = await pool.query(`
      DELETE FROM articles
      WHERE id IN (
        SELECT a.id
        FROM articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        WHERE a.published_at < NOW() - ($1 || ' days')::interval
          AND COALESCE(ns.popularity_score, 0) <= $2
        LIMIT $3
      )
    `, [String(CONFIG.MIN_AGE_DAYS), CONFIG.MAX_SOURCE_SCORE, CONFIG.BATCH_SIZE]);

    totalDeleted += rowCount;
    if (rowCount > 0) {
      process.stdout.write(`  Deleted ${totalDeleted.toLocaleString()} articles...\r`);
    }
    if (rowCount < CONFIG.BATCH_SIZE) break;
  }

  console.log(`  ✓ Deleted ${totalDeleted.toLocaleString()} articles`);

  // Clean up orphaned article_keywords
  const { rowCount: kwDeleted } = await pool.query(`
    DELETE FROM article_keywords ak
    WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = ak.article_id)
  `);
  console.log(`  ✓ Cleaned ${kwDeleted.toLocaleString()} orphaned article_keywords rows`);

  if (DO_VACUUM) {
    console.log('  Running VACUUM ANALYZE...');
    await pool.query('VACUUM ANALYZE articles');
    await pool.query('VACUUM ANALYZE article_keywords');
    console.log('  ✓ VACUUM ANALYZE complete');
  }

  console.log('');
}

async function main() {
  try {
    await analyze();

    if (DO_PRUNE) {
      await prune();
      await analyze(); // Show final state
    } else if (!ANALYZE_ONLY) {
      console.log('  Run with --analyze to inspect or --prune to delete.\n');
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
