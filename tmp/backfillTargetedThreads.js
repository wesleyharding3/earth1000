require("dotenv").config({ override: true });
const pool = require("../db");
const { processArticleById } = require("../entityResolver");

const THREAD_IDS = [8203, 8479, 8502, 8463];

(async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT sta.article_id, sta.thread_id
     FROM story_thread_articles sta
     WHERE sta.thread_id = ANY($1::int[])
     ORDER BY sta.article_id`,
    [THREAD_IDS]
  );
  console.log(`Found ${rows.length} articles across ${THREAD_IDS.length} threads`);

  // Mark them all 'pending' (or insert) so processArticleById runs fresh
  await pool.query(
    `INSERT INTO article_entity_extraction_state (article_id, status, processed_at)
     SELECT unnest($1::int[]), 'pending', NOW()
     ON CONFLICT (article_id) DO UPDATE SET status='pending', processed_at=NOW()`,
    [rows.map(r => r.article_id)]
  );

  let ok = 0, fail = 0, skip = 0;
  for (const r of rows) {
    process.stdout.write(`  art=${r.article_id} (thread #${r.thread_id})... `);
    try {
      const result = await processArticleById(r.article_id, { dryRun: false });
      if (result.skipped) { skip++; console.log(`skipped (${result.reason || 'no reason'})`); }
      else {
        ok++;
        const ent = result.summary?.entities?.length || 0;
        const men = result.summary?.mentions_inserted || 0;
        console.log(`✓ ${ent} entities, ${men} mentions`);
      }
    } catch (e) {
      fail++;
      console.log(`✗ ${e.message.slice(0,200)}`);
    }
  }
  console.log(`\nDone. ok=${ok} fail=${fail} skip=${skip}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
