

require("dotenv").config();

const Parser = require("rss-parser");
const pool = require("./db");

// WHAT: Configure rss-parser with browser-like headers and loose XML parsing
// WHY:  .xml/.feed endpoints commonly return 403 or Content-Type:text/html,
//       and some use ISO-8859-1 encoding — these options handle all three cases
const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; RSSFetcher/1.0; +https://yoursite.com)",
    "Accept":
      "application/rss+xml, application/xml, text/xml, application/atom+xml, */*"
  },
  defaultRSS: 2.0,
  xml2js: {
    strict: false,
    normalize: true,
    normalizeTags: true
  }
});

// ===============================
// Google Translate Config
// ===============================

// WHAT: Replace DeepL constants with Google Translate equivalents
// WHY:  DeepL key is broken; Google Translate v2 uses a simple API key + JSON POST
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY?.trim() || null;
const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
let translateDisabled = !GOOGLE_TRANSLATE_API_KEY;

// WHAT: Only log Google Translate config — DeepL lines removed
// WHY:  DEEPL_API_KEY, isFreeKey, DEEPL_URL no longer exist and would
//       throw a ReferenceError on startup before any feed is fetched
console.log("=== Google Translate Config ===");
console.log("Key present:", !!GOOGLE_TRANSLATE_API_KEY);
console.log("Key last 5 chars:", GOOGLE_TRANSLATE_API_KEY?.slice(-5));

// ===============================
// Translation Helper
// ===============================

// WHAT: Rewritten to call Google Translate v2 instead of DeepL
// WHY:  Different auth method (query param key vs header), different request
//       body shape (JSON vs form-encoded), different response path
async function translateText(text, target = "en") {
  if (!text || translateDisabled) return null;

  try {
    const url = `${GOOGLE_TRANSLATE_URL}?key=${GOOGLE_TRANSLATE_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: text,
        target,
        format: "text"
      })
    });

    // WHAT: Disable on 400/403 to avoid burning quota on a bad key
    // WHY:  Google returns 400 for invalid keys, 403 for quota/permission issues
    if (response.status === 400 || response.status === 403) {
      const errorText = await response.text();
      console.error(`❌ Google Translate ${response.status} — disabling translations.`, errorText);
      translateDisabled = true;
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Google Translate API error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    // WHAT: Different response path from DeepL
    // WHY:  Google wraps result in data.data.translations[0].translatedText
    return data.data?.translations?.[0]?.translatedText || null;

  } catch (err) {
    console.error("Translation error:", err.message);
    return null;
  }
}

// ===============================
// Utility: Clean HTML
// ===============================

function cleanText(text) {
  return text?.replace(/<[^>]*>/g, "").trim();
}

// ===============================
// Error Logger
// ===============================

async function logFeedError(feed, err, type = "RSS_FETCH_ERROR") {
  try {
    const timestamp = new Date().toISOString();

    console.error("❌ RSS ERROR:", {
      feed_id: feed.id,
      rss_url: feed.rss_url,
      error_type: type,
      message: err.message,
      timestamp
    });

    // Insert into persistent error log table
    await pool.query(
      `
      INSERT INTO rss_error_logs (
        feed_id,
        rss_url,
        error_type,
        error_message,
        stack_trace
      )
      VALUES ($1,$2,$3,$4,$5)
      `,
      [
        feed.id,
        feed.rss_url,
        type,
        err.message?.substring(0, 1000) || null,
        err.stack?.substring(0, 5000) || null
      ]
    );

    // Update quick-view error fields in news_sources
    await pool.query(
      `
      UPDATE news_sources
      SET last_error = $1,
          last_failed_at = NOW()
      WHERE id = $2
      `,
      [err.message?.substring(0, 1000), feed.id]
    );

  } catch (logErr) {
    console.error("🚨 CRITICAL: Failed to log RSS error:", logErr);
  }
}

// ===============================
// Main Fetch Function
// ===============================

async function fetchFeeds() {

// WHAT: Log Google Translate key status instead of DeepL
  // WHY:  DEEPL_API_KEY is undefined — referencing it here would throw
  //       a ReferenceError and abort the entire fetch run
  console.log("Starting RSS fetch...");
  console.log("Google Translate key exists:", !!GOOGLE_TRANSLATE_API_KEY);

  const feedResult = await pool.query(`
    SELECT id, country_id, rss_url, city_id, failure_count
    FROM news_sources
    WHERE is_active = true
  `);

  const feeds = feedResult.rows;

  for (const feed of feeds) {

    try {

      if (!feed.rss_url) continue;

      console.log(`Fetching: ${feed.rss_url}`);

      // WHAT: Timeout extended from 10s → 15s
      // WHY:  .xml and .feed endpoints hosted on slower regional servers
      //       were hitting the 10s limit and logging false failures
      const parsed = await Promise.race([
        parser.parseURL(feed.rss_url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Feed timeout")), 15000)
        )
      ]);

      // WHAT: Skip feeds that parsed successfully but returned no items
      // WHY:  Some endpoints return valid XML with an empty <channel> —
      //       without this guard the loop continues and logs a false success
      if (!parsed.items || parsed.items.length === 0) {
        console.warn(`⚠️  No items found in feed: ${feed.rss_url}`);
        continue;
      }

      const feedLanguage = parsed.language || "unknown";

      for (const item of parsed.items) {

        const originalTitle = cleanText(item.title);
        const originalSummary =
          cleanText(item.contentSnippet || item.description);

        const publishedAt =
          item.pubDate ? new Date(item.pubDate) : null;

        let translatedTitle = null;
        let translatedSummary = null;

        // Translate only if NOT English
// Translate only if NOT English
        // WHAT: Explicit "en" passed to both calls
        // WHY:  DeepL used "EN" (uppercase); Google Translate requires
        //       lowercase BCP-47 codes — default param alone isn't enough
        //       if old call sites passed "EN" explicitly elsewhere
        if (
          feedLanguage &&
          !feedLanguage?.toLowerCase().startsWith("en")
        ) {
          translatedTitle   = await translateText(originalTitle,   "en");
          translatedSummary = await translateText(originalSummary, "en");
        }
        await pool.query(
          `
          INSERT INTO news_articles (
            source_id,
            city_id,
            country_id,
            title,
            translated_title,
            url,
            summary,
            translated_summary,
            content,
            language,
            published_at,
            ingested_at,
            raw_json
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12
          )
          ON CONFLICT (url)
          DO UPDATE SET
            translated_title   = COALESCE(EXCLUDED.translated_title, news_articles.translated_title),
            translated_summary = COALESCE(EXCLUDED.translated_summary, news_articles.translated_summary);
          `,
          [
            feed.id,
            feed.city_id,
            feed.country_id,
            originalTitle,
            translatedTitle,
            item.link || null,
            originalSummary,
            translatedSummary,
            item.content || null,
            feedLanguage,
            publishedAt,
            JSON.stringify(item)
          ]
        );
      }

      // ===============================
      // SUCCESS RESET
      // ===============================

      await pool.query(`
        UPDATE news_sources
        SET failure_count = 0,
            last_success_at = NOW(),
            last_error = NULL
        WHERE id = $1
      `, [feed.id]);

      console.log(`Finished successfully: ${feed.rss_url}`);

    } catch (err) {

      await logFeedError(feed, err);

      await pool.query(`
        UPDATE news_sources
        SET failure_count = COALESCE(failure_count,0) + 1,
            last_failed_at = NOW()
        WHERE id = $1
      `, [feed.id]);

      await pool.query(`
        UPDATE news_sources
        SET is_active = false
        WHERE id = $1
          AND failure_count >= 10
      `, [feed.id]);
    }
  }

  console.log("RSS fetch complete.");
}

module.exports = fetchFeeds;