// fetcher.js

const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser();

/**
 * Extract image URL from RSS item (if present)
 */
function extractImage(item) {
  // 1. Standard enclosure
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }

  // 2. media:content (some feeds use this)
  if (item.media && item.media.content && item.media.content.url) {
    return item.media.content.url;
  }

  // 3. Extract first <img> from HTML content
  if (item.content) {
    const match = item.content.match(/<img[^>]+src="([^">]+)"/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Fetch all RSS feeds and store articles in DB
 */
async function fetchFeeds() {
  try {
    console.log("Starting RSS fetch...");

    // Get all feed URLs from database
    const feedResult = await pool.query("SELECT * FROM news_sources");
    const feeds = feedResult.rows;

    for (const feed of feeds) {
      try {
        console.log(`Fetching: ${feed.url}`);

        const parsed = await parser.parseURL(feed.url);

        for (const item of parsed.items) {
          const imageUrl = extractImage(item);

          await pool.query(
            `
            INSERT INTO news_articles (
              source_id,
              title,
              url,
              summary,
              content,
              published_at,
              ingested_at,
              raw_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
            ON CONFLICT (url) DO NOTHING
            `,
            [
              feed.id,
              item.title || null,
              item.link || null,
              item.contentSnippet || item.description || null,
              item.content || null,
              item.pubDate ? new Date(item.pubDate) : null,
              JSON.stringify(item)
            ]
          );
        }


        console.log(`Finished: ${feed.url}`);
      } catch (err) {
        console.error(`Error fetching ${feed.url}:`, err.message);
      }
    }

    console.log("RSS fetch complete.");
  } catch (err) {
    console.error("Fatal fetch error:", err.message);
  }
}

module.exports = fetchFeeds;
