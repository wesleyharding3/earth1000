require("dotenv").config();
const pool = require("./db");
const Parser = require("rss-parser");

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (RSS Validator)"
  }
});

const MAX_FEED_SIZE = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;

/* =========================================
   Fetch With Timeout
========================================= */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const start = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (RSS Validator)"
      }
    });

    const duration = Date.now() - start;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    if (text.length > MAX_FEED_SIZE) {
      throw new Error("Feed exceeds max size");
    }

    const parsed = await parser.parseString(text);

    if (!parsed.items || parsed.items.length === 0) {
      throw new Error("No RSS items found");
    }

    return {
      status: response.status,
      duration,
      itemCount: parsed.items.length
    };

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
    SELECT id, rss_url
    FROM news_sources
    WHERE rss_valid IS NULL
       OR is_active = false
    ORDER BY id ASC
    LIMIT 500
  `);

  console.log(`Feeds selected: ${rows.length}`);

  for (const feed of rows) {
    try {
      const result = await fetchWithTimeout(feed.rss_url);

      await pool.query(`
        UPDATE news_sources
        SET rss_valid = true,
            is_active = true,
            rss_last_status = $2,
            rss_last_checked_at = NOW(),
            rss_validation_error = NULL,
            rss_response_ms = $3,
            rss_item_count = $4
        WHERE id = $1
      `, [
        feed.id,
        result.status,
        result.duration,
        result.itemCount
      ]);

      console.log(`✅ Activated: ${feed.rss_url}`);

    } catch (err) {
      await pool.query(`
        UPDATE news_sources
        SET rss_valid = false,
            is_active = false,
            rss_last_checked_at = NOW(),
            rss_validation_error = $2,
            rss_response_ms = NULL,
            rss_item_count = NULL
        WHERE id = $1
      `, [feed.id, err.message]);

      console.log(`❌ Deactivated: ${feed.rss_url} → ${err.message}`);
    }
  }

  console.log("🏁 Targeted validation complete.");
}

validateFeeds()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("💥 Validator crashed:", err);
    process.exit(1);
  });