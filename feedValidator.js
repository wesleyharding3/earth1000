require("dotenv").config();
const pool = require("./db");

const fetch = global.fetch; // Node 18+ native fetch
const TIMEOUT_MS = 15000;
const MAX_FEED_SIZE = 2 * 1024 * 1024;

/* =========================================
   Fetch With Timeout
========================================= */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (RSS Validator)"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    if (text.length > MAX_FEED_SIZE) {
      throw new Error("Feed exceeds max size");
    }

    return true;
  } finally {
    clearTimeout(timeout);
  }
}

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

  console.log(`📋 Feeds selected: ${rows.length}`);

  let activatedCount = 0;
  let deactivatedCount = 0;
  let alreadyFalseCount = 0;

  for (const feed of rows) {
    const wasActive = feed.is_active;

    try {
      await fetchWithTimeout(feed.rss_url);

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
        console.log(`❌ Deactivated: ${feed.rss_url} → ${err.message}`);
      } else {
        alreadyFalseCount++;
        console.log(`⛔ Still inactive: ${feed.rss_url} → ${err.message}`);
      }
    }
  }

  console.log(`
🏁 Targeted validation complete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Activated:      ${activatedCount}
❌ Deactivated:    ${deactivatedCount}
⛔ Still inactive: ${alreadyFalseCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}

/* =========================================
   Cron Runner
========================================= */
async function run() {
  try {
    console.log("🕒 Feed Validator Cron Started:", new Date().toISOString());
    await validateFeeds();
    console.log("✅ Feed Validator Finished");
    process.exit(0);
  } catch (err) {
    console.error("💥 Feed Validator Failed:", err);
    process.exit(1);
  }
}

/* =========================================
   Only run if executed directly
========================================= */
if (require.main === module) {
  run();
}

module.exports = { validateFeeds };