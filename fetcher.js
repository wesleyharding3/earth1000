

require("dotenv").config();

const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser();

// ===============================
// DeepL Config
// ===============================

const DEEPL_API_KEY = process.env.DEEPL_API_KEY?.trim() || null;
const isFreeKey = DEEPL_API_KEY?.endsWith(":fx") === true;
const DEEPL_URL = isFreeKey
  ? "https://api-free.deepl.com/v2/translate"
  : "https://api.deepl.com/v2/translate";
let deeplDisabled = !DEEPL_API_KEY;

// Add this right after so you can see exactly what's happening in Render logs
console.log("=== DeepL Config ===");
console.log("Key present:", !!DEEPL_API_KEY);
console.log("Key last 5 chars:", DEEPL_API_KEY?.slice(-5));
console.log("Is free key:", isFreeKey);
console.log("URL:", DEEPL_URL);

// ===============================
// Translation Helper
// ===============================

async function translateText(text, target = "EN") {
  if (!text || deeplDisabled) return null;

  try {
    const response = await fetch(DEEPL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        auth_key: DEEPL_API_KEY,
        text,
        target_lang: target
      })
    });

    if (response.status === 403) {
      console.error("❌ DeepL 403 Forbidden — disabling translations.");
      deeplDisabled = true;
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("DeepL API error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.translations?.[0]?.text || null;

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

  console.log("Starting RSS fetch...");
  console.log("DeepL key exists:", !!DEEPL_API_KEY);

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

      // Timeout protection (10 seconds)
      const parsed = await Promise.race([
        parser.parseURL(feed.rss_url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Feed timeout")), 10000)
        )
      ]);

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
        if (
          feedLanguage &&
          feedLanguage.toLowerCase() !== "en"
        ) {
          translatedTitle = await translateText(originalTitle);
          translatedSummary = await translateText(originalSummary);
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