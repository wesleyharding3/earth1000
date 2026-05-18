#!/usr/bin/env node
'use strict';

/**
 * backfillEmbeddings.js — populate news_articles.embedding for rows
 * that don't have one yet.
 *
 * Doubles as the steady-state cron entry point: at full backfill
 * (steady-state) the WHERE clause finds zero rows so each run does
 * ~0 work. New articles trickle in throughout the day; this script
 * embeds them in batches on whatever cadence you schedule it.
 *
 * Strategy:
 *   - Pull rows WHERE embedding IS NULL, ORDER BY id DESC (newest first),
 *     LIMIT BATCH_SIZE. Newest-first means new ingest doesn't have to
 *     wait behind a 100k-article backlog.
 *   - Build embedding text via embedder.articleToEmbeddingText() — title
 *     + first 300 chars of summary.
 *   - Embed the batch in one pipeline call (much faster than per-row).
 *   - UPDATE each row with the resulting vector + timestamp.
 *
 * Knobs (all env vars):
 *   BACKFILL_BATCH_SIZE       default 64    (embed model batch size)
 *   BACKFILL_TOTAL_LIMIT      default 0     (0 = no cap, run until done)
 *   BACKFILL_LOOKBACK_DAYS    default 30    (only embed articles newer than N days)
 *
 * Usage:
 *   node backfillEmbeddings.js                       — embed up to BACKFILL_TOTAL_LIMIT
 *   BACKFILL_TOTAL_LIMIT=200 node backfillEmbeddings.js   — embed 200 articles
 *   BACKFILL_LOOKBACK_DAYS=7 node backfillEmbeddings.js   — only last week
 *
 * First-run note: the model file (~470MB) downloads on first invocation
 * and is cached to ~/.cache/huggingface/ thereafter. Allow ~30s for that
 * first run.
 */

require('dotenv').config();
const pool = require('./db');
const { embedBatch, articleToEmbeddingText, vectorToPgString, MODEL_ID } = require('./embedder');

const BATCH_SIZE      = parseInt(process.env.BACKFILL_BATCH_SIZE    || '64', 10);
const TOTAL_LIMIT     = parseInt(process.env.BACKFILL_TOTAL_LIMIT   || '0', 10);
const LOOKBACK_DAYS   = parseInt(process.env.BACKFILL_LOOKBACK_DAYS || '30', 10);

async function run() {
  const t0 = Date.now();
  console.log(`\n[backfill-embeddings] start ${new Date().toISOString()}`);
  console.log(`  model        = ${MODEL_ID}`);
  console.log(`  batch_size   = ${BATCH_SIZE}`);
  console.log(`  total_limit  = ${TOTAL_LIMIT || 'unbounded'}`);
  console.log(`  lookback_days = ${LOOKBACK_DAYS}\n`);

  // How many rows still need embedding (informational, not blocking).
  const { rows: [countRow] } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM news_articles
     WHERE embedding IS NULL
       AND published_at > NOW() - ($1::int * INTERVAL '1 day')
  `, [LOOKBACK_DAYS]);
  console.log(`  ${countRow.n} article(s) still need embedding in the lookback window.\n`);
  if (countRow.n === 0) {
    console.log('  Nothing to do.');
    await pool.end();
    return;
  }

  let totalEmbedded = 0;
  let totalSkipped  = 0;
  let batchNum = 0;

  // Loop until we've embedded TOTAL_LIMIT rows (or the candidate pool
  // is exhausted, whichever comes first).
  while (true) {
    if (TOTAL_LIMIT > 0 && totalEmbedded >= TOTAL_LIMIT) break;

    // Pull a batch of unembedded articles.
    const batchLimit = TOTAL_LIMIT > 0
      ? Math.min(BATCH_SIZE, TOTAL_LIMIT - totalEmbedded)
      : BATCH_SIZE;
    // Prefer translated_title/summary when present (English form of
    // non-English articles), fall back to the original. That way the
    // multilingual embedding model can lean on both signals.
    const { rows } = await pool.query(`
      SELECT id,
             COALESCE(translated_title, title)     AS title,
             COALESCE(translated_summary, summary) AS summary
        FROM news_articles
       WHERE embedding IS NULL
         AND published_at > NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY id DESC
       LIMIT $2
    `, [LOOKBACK_DAYS, batchLimit]);

    if (rows.length === 0) break;

    batchNum++;

    // Build the text payload for each article. Skip rows where we'd be
    // embedding a useless empty string — mark them with a sentinel
    // timestamp so we don't re-pick them on every run, but leave
    // embedding NULL so the index's partial WHERE still excludes them.
    const embedTexts = [];
    const indexByText = [];
    const emptyIds = [];
    for (const r of rows) {
      const text = articleToEmbeddingText(r);
      if (text.trim().length < 5) {
        emptyIds.push(r.id);
        continue;
      }
      embedTexts.push(text);
      indexByText.push(r.id);
    }

    if (emptyIds.length) {
      await pool.query(`
        UPDATE news_articles
           SET embedding_generated_at = NOW()
         WHERE id = ANY($1::int[])
      `, [emptyIds]);
      totalSkipped += emptyIds.length;
    }

    if (embedTexts.length === 0) {
      console.log(`  batch ${batchNum}: all ${rows.length} rows had empty text — skipped`);
      continue;
    }

    // Run the embed pipeline once on the whole batch.
    const tEmbed0 = Date.now();
    const vectors = await embedBatch(embedTexts);
    const embedMs = Date.now() - tEmbed0;

    // Write back. Use a single multi-row UPDATE via UNNEST to keep
    // round-trip count low. pgvector accepts text format on input.
    const idArr  = indexByText;
    const vecArr = vectors.map(v => vectorToPgString(v));
    const tDb0 = Date.now();
    await pool.query(`
      UPDATE news_articles AS a
         SET embedding              = pairs.vec::vector,
             embedding_generated_at = NOW()
        FROM (SELECT unnest($1::int[]) AS id,
                     unnest($2::text[]) AS vec) AS pairs
       WHERE a.id = pairs.id
    `, [idArr, vecArr]);
    const dbMs = Date.now() - tDb0;

    totalEmbedded += embedTexts.length;
    const rate = (totalEmbedded / ((Date.now() - t0) / 1000)).toFixed(1);
    console.log(
      `  batch ${batchNum.toString().padStart(4)}  ` +
      `embedded=${embedTexts.length}  ` +
      `total=${totalEmbedded}  ` +
      `embed=${embedMs}ms  db=${dbMs}ms  ` +
      `rate=${rate}/s`
    );
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[backfill-embeddings] done.`);
  console.log(`  embedded:  ${totalEmbedded}`);
  console.log(`  skipped:   ${totalSkipped} (empty text)`);
  console.log(`  elapsed:   ${elapsedS}s`);
  await pool.end();
}

run().catch(err => {
  console.error('[backfill-embeddings] fatal:', err);
  process.exit(1);
});
