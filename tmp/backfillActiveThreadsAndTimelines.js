require("dotenv").config({ override: true });
const pool = require("../db");
const { processArticleById } = require("../entityResolver");

const CONCURRENCY = 5;
const PROGRESS_EVERY = 50;

(async () => {
  const { rows } = await pool.query(`
    SELECT DISTINCT u.art_id
    FROM (
      SELECT sta.article_id AS art_id
      FROM story_thread_articles sta
      JOIN story_threads st ON st.id = sta.thread_id
      WHERE st.status='active'
      UNION
      SELECT article_id FROM story_timeline_articles
    ) u
    LEFT JOIN article_entity_extraction_state s ON s.article_id = u.art_id
    JOIN news_articles na ON na.id = u.art_id
    WHERE (s.article_id IS NULL OR s.status IN ('pending','failed'))
      AND na.summary IS NOT NULL
      AND length(na.summary) > 50
    ORDER BY u.art_id
  `);
  const ids = rows.map(r => r.art_id);
  console.log(`[${new Date().toISOString()}] Backfill scope: ${ids.length} articles, concurrency=${CONCURRENCY}`);

  // Reset any rows that we may have left in 'processing' from a prior aborted run.
  // Don't pre-mark — processArticleById skips status='processing'/'done' rows,
  // and the in-process queue.shift() already prevents double-work between workers.
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    await pool.query(
      `UPDATE article_entity_extraction_state
       SET status='pending'
       WHERE article_id = ANY($1::int[]) AND status='processing'`,
      [slice]
    );
  }

  let ok = 0, fail = 0, skip = 0, done = 0, mentions = 0;
  const start = Date.now();
  const queue = [...ids];

  async function worker(wid) {
    while (queue.length) {
      const id = queue.shift();
      if (id == null) return;
      try {
        const result = await processArticleById(id, { dryRun: false });
        if (result.skipped) skip++;
        else { ok++; mentions += result.summary?.mentions_inserted || 0; }
      } catch (e) {
        fail++;
        if (fail <= 5 || fail % 25 === 0) {
          console.error(`  ✗ art=${id}: ${e.message.slice(0, 140)}`);
        }
      } finally {
        done++;
        if (done % PROGRESS_EVERY === 0) {
          const elapsed = (Date.now() - start) / 1000;
          const rate = done / elapsed;
          const eta = (ids.length - done) / Math.max(rate, 0.001);
          console.log(`  [${new Date().toISOString()}] ${done}/${ids.length} ok=${ok} fail=${fail} skip=${skip} mentions=${mentions} ${rate.toFixed(2)}/s ETA=${(eta/60).toFixed(1)}m`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  const elapsed = (Date.now() - start) / 1000;
  console.log(`\n[${new Date().toISOString()}] DONE. processed=${done} ok=${ok} fail=${fail} skip=${skip} mentions=${mentions} elapsed=${(elapsed/60).toFixed(1)}m est_cost=$${(ok * 0.001).toFixed(2)}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
