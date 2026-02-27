/* =========================================
   Main Validator
========================================= */
async function validateFeeds() {
  console.log("🔎 Starting targeted feed validation...");

  const { rows } = await pool.query(`
    SELECT id, rss_url, is_active
    FROM news_sources
    WHERE last_checked_at IS NULL
       OR is_active = false
    ORDER BY id ASC
  `);

  console.log(`Feeds selected: ${rows.length}`);

  let activatedCount = 0;
  let deactivatedCount = 0;
  let alreadyFalseCount = 0;

  for (const feed of rows) {
    const wasActive = feed.is_active;

    try {
      await fetchWithTimeout(feed.rss_url);

      // OPTIONAL: Require at least one article to exist
      const { rowCount } = await pool.query(`
        SELECT 1
        FROM news_articles
        WHERE source_id = $1
        LIMIT 1
      `, [feed.id]);

      if (rowCount === 0) {
        throw new Error("No articles exist for this source");
      }

      await pool.query(`
        UPDATE news_sources
        SET
          is_active = true,
          last_checked_at = NOW(),
          last_success_at = NOW(),
          last_error = NULL,
          failure_count = 0
        WHERE id = $1
      `, [feed.id]);

      if (!wasActive) activatedCount++;
      console.log(`✅ Activated: ${feed.rss_url}`);

    } catch (err) {
      await pool.query(`
        UPDATE news_sources
        SET
          is_active = false,
          last_checked_at = NOW(),
          last_failed_at = NOW(),
          last_error = $2,
          failure_count = failure_count + 1
        WHERE id = $1
      `, [feed.id, err.message]);

      if (wasActive) {
        deactivatedCount++;
        console.log(`❌ Deactivated (was active): ${feed.rss_url} → ${err.message}`);
      } else {
        alreadyFalseCount++;
        console.log(`❌ Still inactive: ${feed.rss_url} → ${err.message}`);
      }
    }
  }

  console.log(`
🏁 Targeted validation complete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Activated (false → true):     ${activatedCount}
❌ Deactivated (true → false):   ${deactivatedCount}
⛔ Still inactive:              ${alreadyFalseCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}