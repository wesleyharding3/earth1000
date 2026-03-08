require("dotenv").config();
const pool = require("./db");
const Parser = require("rss-parser");

const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }
});

/* =========================================
   Config
========================================= */

const TIMEOUT_MS = 15000;
const MAX_FEED_SIZE = 2 * 1024 * 1024;

// Toggle full inactive validation
const CHECK_INACTIVE = process.env.CHECK_INACTIVE === "true";

/* =========================================
   Utilities
========================================= */

function sanitizeText(text) {
  if (!text) return text;
  return text.replace(/\u0000/g, "").substring(0, 1000);
}

/* =========================================
   Fetch With Timeout
========================================= */

async function fetchXmlWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    if (text.length > MAX_FEED_SIZE) {
      throw new Error("Feed exceeds max size");
    }

    return text;

  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================
   Main Validator
========================================= */

async function validateFeeds() {

  console.log("🔎 Starting targeted feed validation...");
  console.log(`⚙️  CHECK_INACTIVE mode: ${CHECK_INACTIVE}`);

  let query;

  if (CHECK_INACTIVE) {
    // Full validation mode (inactive or stale feeds)
    query = `
      SELECT id, rss_url, is_active
      FROM news_sources
      WHERE
        (
          last_checked_at IS NULL
          OR last_checked_at < NOW() - INTERVAL '2 days'
        )
        AND (
          last_checked_at IS NULL
          OR last_checked_at < NOW() - INTERVAL '7 days'
          OR is_active = false
        )
      ORDER BY last_checked_at NULLS FIRST
    `;
  } else {
    // Only feeds never checked (still enforce 2-day rule)
    query = `
      SELECT id, rss_url, is_active
      FROM news_sources
      WHERE
        last_checked_at IS NULL
        OR last_checked_at < NOW() - INTERVAL '2 days'
      ORDER BY id ASC
    `;
  }

  const { rows } = await pool.query(query);

  console.log(`📋 Feeds selected: ${rows.length}`);

  let activatedCount = 0;
  let deactivatedCount = 0;
  let alreadyFalseCount = 0;

  for (const feed of rows) {

    const wasActive = feed.is_active;

    try {

      const xml = await fetchXmlWithTimeout(feed.rss_url);
      const parsed = await parser.parseString(xml);

      if (!parsed.items || parsed.items.length === 0) {
        throw new Error("No RSS items found");
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

      console.log(`✅ Valid RSS: ${feed.rss_url} (${parsed.items.length} items)`);

    } catch (err) {

      const cleanError = sanitizeText(err.message);

      await pool.query(`
        UPDATE news_sources
        SET
          is_active = false,
          last_checked_at = NOW(),
          last_failed_at = NOW(),
          last_error = $2,
          failure_count = COALESCE(failure_count,0) + 1
        WHERE id = $1
      `, [feed.id, cleanError]);

      if (wasActive) {
        deactivatedCount++;
        console.log(`❌ Deactivated: ${feed.rss_url} → ${cleanError}`);
      } else {
        alreadyFalseCount++;
        console.log(`⛔ Still inactive: ${feed.rss_url} → ${cleanError}`);
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
   Runner
========================================= */

async function run() {

  try {

    console.log("🕒 Feed Validator Cron Started:", new Date().toISOString());

    await validateFeeds();

    console.log("✅ Feed Validator Finished");

    process.exit(0);

  } catch (err) {

    console.error("💥 Feed Validator Failed:", sanitizeText(err.message));

    process.exit(1);

  }

}

/* =========================================
   Only execute when run directly
========================================= */

if (require.main === module) {
  run();
}

module.exports = { validateFeeds };