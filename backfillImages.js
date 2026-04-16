// backfillImages.js
//
// Assigns a fallback image to every article that has no image_url and
// no existing article_image_assignments row.
//
// Checkpoint-based: safe to kill and restart — resumes from last processed ID.
//
// Usage:
//   node backfillImages.js              # full run
//   node backfillImages.js --dry-run    # count only, no writes
//   node backfillImages.js --reset      # clear checkpoint and start fresh

require("dotenv").config();
const pool = require("./db");
const { resolveImageForArticle } = require("./imageResolver");

// ─── Config ────────────────────────────────────────────────────
const BATCH_SIZE   = 100;
const CONCURRENCY  = 10;
const DELAY_MS     = 0;    // no delay — saturation cache keeps DB load sane
const JOB_NAME     = "backfill_images_v3_tiered";

// Tier/score gate: we only assign fallback images when the source is unreliable
// enough to warrant it and the article's content signal is strong enough that
// it might actually surface. Tier 1 sources bring their own good images and
// mostly never reach the front-end anyway; skip them.
//   tier 2  →  base_priority ≥ 0.70   (high only)
//   tier 3  →  base_priority ≥ 0.40   (mid + high)
//   tier 4  →  any base_priority      (all)
const TIER_SCORE_GATE_SQL = `(
     (COALESCE(ns.popularity_tier, ys.popularity_tier) = 2 AND a.base_priority >= 0.70)
  OR (COALESCE(ns.popularity_tier, ys.popularity_tier) = 3 AND a.base_priority >= 0.40)
  OR (COALESCE(ns.popularity_tier, ys.popularity_tier) = 4)
)`;
const CANDIDATE_JOINS = `
    LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
    LEFT JOIN news_sources    ns ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id`;
const CANDIDATE_WHERE = `
    WHERE aia.article_id IS NULL
      AND (a.image_url IS NULL OR a.image_url = '')
      AND ${TIER_SCORE_GATE_SQL}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("resolve timeout")), ms))
  ]);
}
const RESOLVE_TIMEOUT_MS = 30000;

// ─── Checkpoint ────────────────────────────────────────────────
async function ensureCheckpointTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      job_name    TEXT PRIMARY KEY,
      last_id     BIGINT NOT NULL DEFAULT 0,
      done        INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadCheckpoint(reset) {
  if (reset) {
    await pool.query(`DELETE FROM backfill_progress WHERE job_name = $1`, [JOB_NAME]);
  }
  const { rows } = await pool.query(
    `SELECT last_id, done, failed FROM backfill_progress WHERE job_name = $1`,
    [JOB_NAME]
  );
  if (rows.length) return rows[0];
  await pool.query(
    `INSERT INTO backfill_progress (job_name, last_id, done, failed) VALUES ($1, 0, 0, 0)`,
    [JOB_NAME]
  );
  return { last_id: 0, done: 0, failed: 0 };
}

async function saveCheckpoint(lastId, done, failed) {
  await pool.query(
    `UPDATE backfill_progress
     SET last_id = $1, done = $2, failed = $3, updated_at = NOW()
     WHERE job_name = $4`,
    [lastId, done, failed, JOB_NAME]
  );
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const reset  = process.argv.includes("--reset");

  await ensureCheckpointTable();
  const checkpoint = await loadCheckpoint(reset);

  let lastId      = parseInt(checkpoint.last_id);
  let totalDone   = parseInt(checkpoint.done);
  let totalFailed = parseInt(checkpoint.failed);

  let remaining = "?";
  try {
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*) AS total
      FROM news_articles a
      ${CANDIDATE_JOINS}
      ${CANDIDATE_WHERE}
        AND a.id > $1
    `, [lastId]);
    remaining = parseInt(countRows[0].total);
  } catch (e) {
    console.warn(`   ⚠️ Count query timed out — continuing anyway`);
  }

  console.log(`\n${dryRun ? "🔍 DRY RUN — " : ""}🖼️  Image backfill — ${new Date().toISOString()}`);
  console.log(`   Resuming from ID > ${lastId}`);
  console.log(`   Previously done: ${totalDone} | failed: ${totalFailed}`);
  console.log(`   Remaining: ${remaining}\n`);

  if (dryRun || remaining === 0) {
    if (remaining === 0) console.log("✅ Nothing to backfill.");
    await pool.end();
    return;
  }

  const startTime = Date.now();

  while (true) {
    let articles;
    try {
      const { rows } = await pool.query(`
        SELECT a.id
        FROM news_articles a
        ${CANDIDATE_JOINS}
        ${CANDIDATE_WHERE}
          AND a.id > $1
        ORDER BY a.id ASC
        LIMIT $2
      `, [lastId, BATCH_SIZE]);
      articles = rows;
    } catch (e) {
      console.warn(`  ⚠️ Batch fetch failed (last_id=${lastId}): ${e.message} — retrying in 5s`);
      await sleep(5000);
      try {
        const { rows } = await pool.query(`
          SELECT a.id
          FROM news_articles a
          ${CANDIDATE_JOINS}
          ${CANDIDATE_WHERE}
            AND a.id > $1
          ORDER BY a.id ASC
          LIMIT $2
        `, [lastId, BATCH_SIZE]);
        articles = rows;
      } catch (e2) {
        console.warn(`  ❌ Batch fetch retry failed — skipping ahead by 1000 IDs`);
        lastId += 1000;
        continue;
      }
    }

    if (!articles.length) break;

    // Process in concurrent chunks
    for (let i = 0; i < articles.length; i += CONCURRENCY) {
      const chunk = articles.slice(i, i + CONCURRENCY);

      const settled = await Promise.allSettled(
        chunk.map(a => withTimeout(resolveImageForArticle(a.id, { surface: "feed" }), RESOLVE_TIMEOUT_MS))
      );

      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        const articleId = chunk[j].id;
        if (outcome.status === "fulfilled") {
          totalDone++;
        } else {
          console.warn(`  ❌ [${articleId}] ${outcome.reason?.message}`);
          totalFailed++;
        }
        lastId = Math.max(lastId, articleId);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate    = elapsed > 0 ? Math.round((totalDone + totalFailed) / elapsed) : "—";
    console.log(`   💾 last_id: ${lastId} | done: ${totalDone} | failed: ${totalFailed} | ${rate}/s | ${elapsed}s`);

    await saveCheckpoint(lastId, totalDone, totalFailed);
    await sleep(DELAY_MS);
  }

  await saveCheckpoint(lastId, totalDone, totalFailed);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🏁 Done in ${elapsed}s`);
  console.log(`   ✅ Assigned: ${totalDone}`);
  console.log(`   ❌ Failed:   ${totalFailed}`);
  console.log(`   📍 Last ID:  ${lastId}`);

  await pool.end();
}

main().catch(err => {
  console.error("🚨 Fatal:", err);
  process.exit(1);
});