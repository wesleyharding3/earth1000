// ===============================
// fetcher.js
// ===============================


const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser();

// ===============================
// Translation Helper (DeepL)
// ===============================

async function translateText(text, target = "EN") {
  if (!text) return null;

  try {
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        auth_key: process.env.DEEPL_API_KEY,
        text,
        target_lang: target
      })
    });

    const data = await response.json();

    if (data.translations && data.translations[0]) {
      return data.translations[0].text;
    }

    return null;

  } catch (err) {
    console.error("Translation error:", err.message);
    return null;
  }
}

// ===============================
// Extract Image (optional)
// ===============================

function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.media?.content?.url) return item.media.content.url;

  if (item.content) {
    const match = item.content.match(/<img[^>]+src="([^">]+)"/);
    if (match) return match[1];
  }

  return null;
}

// ===============================
// Main Fetch Function
// ===============================

async function fetchFeeds() {
  try {
    console.log("Starting RSS fetch...");

    const feedResult = await pool.query(`
      SELECT id, country_id, rss_url, city_id
      FROM news_sources
      WHERE is_active = true
    `);

    const feeds = feedResult.rows;

    for (const feed of feeds) {
      try {
        console.log(`Fetching: ${feed.rss_url}`);

        const parsed = await parser.parseURL(feed.rss_url);
        const feedLanguage = parsed.language || "unknown";

        for (const item of parsed.items) {

          const originalTitle =
            item.title || null;

          const originalSummary =
            item.contentSnippet ||
            item.description ||
            null;

          const publishedAt =
            item.pubDate
              ? new Date(item.pubDate)
              : null;

          // --------------------------------
          // Only translate if NOT English
          // --------------------------------

          let translatedTitle = null;
          let translatedSummary = null;

          if (
            feedLanguage &&
            feedLanguage.toLowerCase() !== "en"
          ) {
            translatedTitle =
              await translateText(originalTitle);

            translatedSummary =
              await translateText(originalSummary);
          }

          // --------------------------------
          // Insert Article
          // --------------------------------

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
              $1, $2, $3,
              $4, $5,
              $6,
              $7, $8,
              $9,
              $10,
              $11,
              NOW(),
              $12
            )

            ON CONFLICT (url) DO NOTHING;
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

        console.log(`Finished: ${feed.rss_url}`);

      } catch (err) {
        console.error(
          `Error fetching ${feed.rss_url}:`,
          err.message
        );
      }
    }

    console.log("RSS fetch complete.");

  } catch (err) {
    console.error("Fatal fetch error:", err);
  }
}

module.exports = fetchFeeds;
