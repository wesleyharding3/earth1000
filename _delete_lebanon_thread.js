// One-shot DESTRUCTIVE — deletes story_thread #8735 ("Israel Breaks
// Lebanon Ceasefire with Beirut Strike") and its 1,444-article join
// rows. Authorized by user (thread is unsalvageably drifted).
//
// Cascade behavior (per schema.sql):
//   story_thread_articles  ON DELETE CASCADE  → auto-clears
//   cluster_nodes          ON DELETE CASCADE  → auto-clears
//   cluster_edges          ON DELETE CASCADE  → auto-clears (both src/tgt)
//   briefing_engagement    ON DELETE SET NULL → auto-nulled
//   segment_story_links    NO ACTION (default RESTRICT) → must NULL first
//
// Briefing-history preservation: segment_story_links rows are NULLed
// (not deleted) so historic briefing segments still reference their
// episode + identity, just lose the thread provenance link.
require("dotenv").config();
const pool = require("./db");

const THREAD_ID = 8735;

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: pre } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1) AS sta,
        (SELECT COUNT(*) FROM segment_story_links   WHERE thread_id = $1) AS ssl,
        (SELECT COUNT(*) FROM cluster_nodes         WHERE thread_id = $1) AS cn,
        (SELECT COUNT(*) FROM cluster_edges
            WHERE source_thread_id = $1 OR target_thread_id = $1)        AS ce,
        (SELECT title FROM story_threads WHERE id = $1)                  AS title
    `, [THREAD_ID]);
    console.log(`Before delete — thread #${THREAD_ID} "${pre[0].title}":`);
    console.log(`  story_thread_articles : ${pre[0].sta}`);
    console.log(`  segment_story_links   : ${pre[0].ssl}  (will be NULLed)`);
    console.log(`  cluster_nodes         : ${pre[0].cn}   (cascade)`);
    console.log(`  cluster_edges         : ${pre[0].ce}   (cascade)`);

    if (!pre[0].title) {
      console.log("(thread not found — abort)");
      await client.query("ROLLBACK");
      await client.release(); await pool.end(); return;
    }

    await client.query(
      `UPDATE segment_story_links SET thread_id = NULL WHERE thread_id = $1`,
      [THREAD_ID]
    );

    const { rowCount } = await client.query(
      `DELETE FROM story_threads WHERE id = $1`,
      [THREAD_ID]
    );
    console.log(`Deleted ${rowCount} story_threads row.`);

    await client.query("COMMIT");
    console.log("✓ committed.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("✗ rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
