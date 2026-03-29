// backfillVideoRoutes.js
// One-time script: route all video articles that have no article_locations rows.
// Run once on the server: node backfillVideoRoutes.js
require("dotenv").config();
const pool = require("./db");
const { routeArticle } = require("./locationRouter");

const BATCH = 50;
const PAUSE_MS = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { rows } = await pool.query(`
    SELECT a.id
    FROM news_articles a
    WHERE a.media_type = 'video'
      AND NOT EXISTS (
        SELECT 1 FROM article_locations al WHERE al.article_id = a.id
      )
    ORDER BY a.id
  `);

  console.log(`📺 Found ${rows.length} unrouted video articles`);
  if (rows.length === 0) { await pool.end(); return; }

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    try {
      await routeArticle(id);
      ok++;
    } catch (err) {
      console.warn(`  ⚠️  Failed to route article ${id}: ${err.message}`);
      fail++;
    }
    if ((i + 1) % BATCH === 0) {
      console.log(`  → ${i + 1}/${rows.length} processed (${ok} ok, ${fail} failed)`);
      await sleep(PAUSE_MS);
    }
  }

  console.log(`\n✅ Done — ${ok} routed, ${fail} failed`);
  await pool.end();
})();
