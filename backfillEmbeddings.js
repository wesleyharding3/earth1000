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
 * Strategy (revised after Fix A — 2026-05-20):
 *
 *   1. Snapshot all pending IDs ONCE at startup (capped at WORK_LIMIT)
 *      via the partial index `idx_news_articles_unembedded` ON
 *      (published_at DESC, id) WHERE embedding IS NULL — see
 *      migrations/20260520_unembedded_partial_index.sql. The query is an
 *      index-only range scan, no heap fetches, no sort. After this we
 *      never touch the partial index again — every subsequent fetch is
 *      by primary key.
 *
 *   2. Iterate the snapshot in chunks of BATCH_SIZE. Each chunk:
 *      - SELECT title/summary by `id = ANY($1)` (PK lookup, constant
 *        time even when the partial index is bloated)
 *      - Embed locally via Xenova (no DB)
 *      - UPDATE multi-row via UNNEST.
 *
 *   3. Per-query statement_timeout=60s on the dedicated client so a
 *      stuck query fails fast (catch + log + continue) instead of
 *      hanging the entire run until the cron-level 30-min timeout.
 *
 * Why this matters: previously the script re-queried the partial
 * index every batch. After ~2500 UPDATEs invalidated entries (rows
 * moved from NULL → vector), the partial index was 80%+ dead tuples
 * waiting for autovacuum, and the SELECT for the next batch could
 * hang for the full 30-min statement_timeout. Snapshotting once
 * sidesteps the bloat entirely.
 *
 * Knobs (all env vars):
 *   BACKFILL_BATCH_SIZE       default 64    (embed model batch size)
 *   BACKFILL_TOTAL_LIMIT      default 0     (0 = no cap, run until done)
 *   BACKFILL_LOOKBACK_DAYS    default 30    (only embed articles newer than N days)
 *   BACKFILL_WORK_LIMIT       default 10000 (max IDs snapshotted per run)
 *   BACKFILL_QUERY_TIMEOUT_MS default 60000 (per-query timeout)
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

const BATCH_SIZE         = parseInt(process.env.BACKFILL_BATCH_SIZE       || '64',    10);
const TOTAL_LIMIT        = parseInt(process.env.BACKFILL_TOTAL_LIMIT      || '0',     10);
const LOOKBACK_DAYS      = parseInt(process.env.BACKFILL_LOOKBACK_DAYS    || '30',    10);
const WORK_LIMIT         = parseInt(process.env.BACKFILL_WORK_LIMIT       || '10000', 10);
const QUERY_TIMEOUT_MS   = parseInt(process.env.BACKFILL_QUERY_TIMEOUT_MS || '60000', 10);

async function run() {
  const t0 = Date.now();
  console.log(`\n[backfill-embeddings] start ${new Date().toISOString()}`);
  console.log(`  model         = ${MODEL_ID}`);
  console.log(`  batch_size    = ${BATCH_SIZE}`);
  console.log(`  total_limit   = ${TOTAL_LIMIT || 'unbounded'}`);
  console.log(`  lookback_days = ${LOOKBACK_DAYS}`);
  console.log(`  work_limit    = ${WORK_LIMIT}`);
  console.log(`  query_timeout = ${QUERY_TIMEOUT_MS}ms\n`);

  // Use ONE dedicated client throughout. Setting statement_timeout on the
  // client applies to every subsequent query on that session, so a single
  // stuck query fails fast (catch + log + continue) rather than hanging
  // the whole run.
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);

    // ─── Snapshot pending IDs ONCE ─────────────────────────────────
    // After this query we never touch the partial index `WHERE
    // embedding IS NULL` again — every fetch below is by primary key
    // (id = ANY). Avoids the bloat-stall problem.
    const tSnap = Date.now();
    let pendingIds;
    try {
      const { rows } = await client.query(`
        SELECT id
          FROM news_articles
         WHERE embedding IS NULL
           AND published_at > NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY published_at DESC, id DESC
         LIMIT $2
      `, [LOOKBACK_DAYS, WORK_LIMIT]);
      pendingIds = rows.map(r => r.id);
    } catch (err) {
      console.error(`[backfill-embeddings] snapshot query failed (${err.code || err.message}). Aborting.`);
      throw err;
    }
    console.log(`  snapshot: ${pendingIds.length} article(s) pending (capped at ${WORK_LIMIT}) in ${Date.now() - tSnap}ms\n`);
    if (pendingIds.length === 0) {
      console.log('  Nothing to do.');
      return;
    }

    let totalEmbedded = 0;
    let totalSkipped  = 0;
    let totalErrored  = 0;
    let batchNum = 0;

    // ─── Iterate the snapshot in BATCH_SIZE chunks ─────────────────
    for (let offset = 0; offset < pendingIds.length; offset += BATCH_SIZE) {
      if (TOTAL_LIMIT > 0 && totalEmbedded >= TOTAL_LIMIT) break;
      const batchIds = pendingIds.slice(offset, offset + BATCH_SIZE);
      batchNum++;

      try {
        // SELECT title/summary by primary key. Postgres uses the PK
        // index, completes in <50ms regardless of partial-index state.
        const { rows } = await client.query(`
          SELECT id,
                 COALESCE(translated_title, title)     AS title,
                 COALESCE(translated_summary, summary) AS summary
            FROM news_articles
           WHERE id = ANY($1::int[])
        `, [batchIds]);

        // Build embedding text. Empty-text rows get marked attempted
        // (embedding_generated_at = NOW) but stay NULL on embedding —
        // they're filtered out of the SELECT-by-id results anyway
        // because they ARE returned but produce no text.
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
          await client.query(`
            UPDATE news_articles
               SET embedding_generated_at = NOW()
             WHERE id = ANY($1::int[])
          `, [emptyIds]);
          totalSkipped += emptyIds.length;
        }

        if (embedTexts.length === 0) {
          console.log(`  batch ${String(batchNum).padStart(4)}  skipped — ${rows.length} rows had empty text`);
          continue;
        }

        // Run the embed pipeline once on the whole batch.
        const tEmbed0 = Date.now();
        const vectors = await embedBatch(embedTexts);
        const embedMs = Date.now() - tEmbed0;

        // Write back. Single multi-row UPDATE via UNNEST.
        const idArr  = indexByText;
        const vecArr = vectors.map(v => vectorToPgString(v));
        const tDb0 = Date.now();
        await client.query(`
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
          `  batch ${String(batchNum).padStart(4)}  ` +
          `embedded=${embedTexts.length}  ` +
          `total=${totalEmbedded}  ` +
          `embed=${embedMs}ms  db=${dbMs}ms  ` +
          `rate=${rate}/s`
        );
      } catch (err) {
        // Per-batch error recovery. Statement timeout (57014), deadlock
        // (40P01), or anything else: log + skip this batch's IDs +
        // move on. Stuck queries are bounded by QUERY_TIMEOUT_MS so a
        // single bad batch can't kill the whole run.
        totalErrored += batchIds.length;
        console.warn(
          `  batch ${String(batchNum).padStart(4)}  ERROR  ` +
          `code=${err.code || '?'}  ${err.message.split('\n')[0]}  ` +
          `(${batchIds.length} ids skipped — will retry next run)`
        );
        // If we got disconnected, the client is unusable — bail out.
        // pg-pool marks the client bad on these codes; trying to use
        // it again throws "Client has encountered a connection error".
        if (err.code === '08006' || err.code === '08003' || err.code === '57P01') {
          console.error('[backfill-embeddings] connection lost — aborting run');
          break;
        }
        // For statement_timeout specifically, the client's session is
        // still usable. Just continue to the next batch.
      }
    }

    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[backfill-embeddings] done.`);
    console.log(`  embedded:    ${totalEmbedded}`);
    console.log(`  skipped:     ${totalSkipped} (empty text)`);
    console.log(`  errored:     ${totalErrored} (will retry next run)`);
    console.log(`  remaining:   ~${Math.max(0, pendingIds.length - totalEmbedded - totalSkipped - totalErrored)} from this snapshot (next run picks up stragglers + new arrivals)`);
    console.log(`  elapsed:     ${elapsedS}s`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('[backfill-embeddings] fatal:', err);
  process.exit(1);
});
