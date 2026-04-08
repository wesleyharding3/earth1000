/**
 * inspectThreads.js
 *
 * Read-only audit of what's left in story_threads after the junk cleanup.
 * Prints summary stats + a sample of remaining threads so you can eyeball
 * quality and decide whether the filter needs another pass.
 *
 * Usage:
 *   node inspectThreads.js                  # full report
 *   node inspectThreads.js --sample=100     # show 100 threads (default 50)
 *   node inspectThreads.js --status=active  # filter by status
 *   node inspectThreads.js --order=imp      # order sample by importance (default: recent)
 */

require("dotenv").config();
const pool = require("./db");

const SAMPLE = parseInt(process.argv.find(a => a.startsWith("--sample="))?.split("=")[1] || "50", 10);
const STATUS = process.argv.find(a => a.startsWith("--status="))?.split("=")[1] || null;
const ORDER  = process.argv.find(a => a.startsWith("--order="))?.split("=")[1] || "recent";

const statusFilter = STATUS ? `WHERE status = '${STATUS}'` : "";

async function section(title, fn) {
  console.log("\n─── " + title + " ─────────────────────────────");
  try { await fn(); } catch (err) { console.error("  ⚠ " + err.message); }
}

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("🔎 story_threads audit");
  console.log("══════════════════════════════════════════════");

  // 1. Total counts
  await section("totals", async () => {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE status = 'active')                 AS active,
        COUNT(*) FILTER (WHERE status = 'cooling')                AS cooling,
        COUNT(*) FILTER (WHERE status = 'dormant')                AS dormant,
        COUNT(*) FILTER (WHERE article_count >= 5)                AS multi_article,
        COUNT(*) FILTER (WHERE article_count = 1)                 AS single_article,
        COUNT(*) FILTER (WHERE last_updated_at >= NOW() - INTERVAL '24 hours') AS updated_24h,
        COUNT(*) FILTER (WHERE last_updated_at >= NOW() - INTERVAL '7 days')   AS updated_7d
      FROM story_threads
    `);
    const r = rows[0];
    console.log(`  total          ${r.total}`);
    console.log(`  active         ${r.active}`);
    console.log(`  cooling        ${r.cooling}`);
    console.log(`  dormant        ${r.dormant}`);
    console.log(`  multi-article  ${r.multi_article}  (≥5 articles)`);
    console.log(`  single-article ${r.single_article}`);
    console.log(`  updated 24h    ${r.updated_24h}`);
    console.log(`  updated 7d     ${r.updated_7d}`);
  });

  // 2. Breakdown by category
  await section("by primary_category", async () => {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(primary_category, '(none)') AS cat,
        COUNT(*) AS n,
        ROUND(AVG(article_count)::numeric, 1) AS avg_arts,
        ROUND(AVG(importance)::numeric, 1)    AS avg_imp
      FROM story_threads
      ${statusFilter}
      GROUP BY 1
      ORDER BY n DESC
    `);
    for (const r of rows) {
      console.log(`  ${String(r.n).padStart(5)}  ${String(r.cat).padEnd(14)} avg_arts=${r.avg_arts}  avg_imp=${r.avg_imp}`);
    }
  });

  // 3. Breakdown by article-count bucket
  await section("by article_count bucket", async () => {
    const { rows } = await pool.query(`
      SELECT
        CASE
          WHEN article_count = 1 THEN '1'
          WHEN article_count BETWEEN 2 AND 4 THEN '2-4'
          WHEN article_count BETWEEN 5 AND 9 THEN '5-9'
          WHEN article_count BETWEEN 10 AND 24 THEN '10-24'
          WHEN article_count BETWEEN 25 AND 49 THEN '25-49'
          WHEN article_count BETWEEN 50 AND 99 THEN '50-99'
          ELSE '100+'
        END AS bucket,
        COUNT(*) AS n
      FROM story_threads
      ${statusFilter}
      GROUP BY 1
      ORDER BY MIN(article_count)
    `);
    for (const r of rows) {
      console.log(`  ${String(r.bucket).padEnd(8)} ${r.n}`);
    }
  });

  // 4. Breakdown by importance
  await section("by importance", async () => {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(importance, 0) AS imp,
        COUNT(*) AS n
      FROM story_threads
      ${statusFilter}
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    for (const r of rows) {
      console.log(`  imp=${String(r.imp).padStart(2)}  ${r.n}`);
    }
  });

  // 5. Title-token frequency — what words dominate the remaining titles?
  // Useful for spotting "the new junk pattern" — if the top tokens are still
  // things like "developments", "updates", "challenges", we have more junk.
  await section("most common title tokens (excludes stopwords)", async () => {
    const { rows } = await pool.query(`
      WITH toks AS (
        SELECT lower(unnest(string_to_array(regexp_replace(title, '[^A-Za-z\\s]', ' ', 'g'), ' '))) AS tok
        FROM story_threads
        ${statusFilter}
      )
      SELECT tok, COUNT(*) AS n
      FROM toks
      WHERE length(tok) >= 4
        AND tok NOT IN (
          'the','and','for','with','from','that','this','have','will','their',
          'after','over','into','than','then','more','most','some','such','what',
          'when','where','which','while','about','been','were','says','said'
        )
      GROUP BY tok
      ORDER BY n DESC
      LIMIT 40
    `);
    for (const r of rows) {
      console.log(`  ${String(r.n).padStart(5)}  ${r.tok}`);
    }
  });

  // 6. Sample of remaining threads
  const orderClause = ORDER === "imp"
    ? "ORDER BY importance DESC NULLS LAST, article_count DESC"
    : ORDER === "arts"
      ? "ORDER BY article_count DESC, last_updated_at DESC"
      : "ORDER BY last_updated_at DESC NULLS LAST";

  await section(`sample of ${SAMPLE} threads (order=${ORDER})`, async () => {
    const { rows } = await pool.query(`
      SELECT id, title, primary_category, status, importance, article_count,
             to_char(last_updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM story_threads
      ${statusFilter}
      ${orderClause}
      LIMIT ${SAMPLE}
    `);
    for (const r of rows) {
      const tag = `[${String(r.id).padStart(5)}] ${String(r.status || '').padEnd(7)} ${String(r.primary_category || '—').padEnd(12)} arts=${String(r.article_count).padStart(3)} imp=${String(r.importance).padStart(2)}`;
      console.log(`  ${tag}  "${r.title}"`);
    }
  });

  // 7. Single-article threads — these are usually the weakest (Claude often
  // creates them speculatively). If most remaining threads are single-article,
  // we may want to require article_count >= 2 in the API list endpoint.
  await section("sample of 20 single-article threads", async () => {
    const { rows } = await pool.query(`
      SELECT id, title, primary_category, importance,
             to_char(last_updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM story_threads
      WHERE article_count = 1
      ${STATUS ? `AND status = '${STATUS}'` : ""}
      ORDER BY last_updated_at DESC NULLS LAST
      LIMIT 20
    `);
    for (const r of rows) {
      console.log(`  [${r.id}] cat=${r.primary_category || '—'} imp=${r.importance}  "${r.title}"`);
    }
  });

  console.log("\n══════════════════════════════════════════════");
  console.log("done.");
  console.log("══════════════════════════════════════════════\n");

  await pool.end();
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
