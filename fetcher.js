// fetcher.js

const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser();

/**
 * Extract image URL from RSS item (if present)
 */
function extractImage(item) {
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }

  if (item.media && item.media.content && item.media.content.url) {
    return item.media.content.url;
  }

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

    const feedResult = await pool.query(`
      SELECT id, rss_url, city_id
      FROM news_sources
      WHERE is_active = true
    `);

    const feeds = feedResult.rows;

    for (const feed of feeds) {
      try {
        console.log(`Fetching: ${feed.rss_url}`);

        const parsed = await parser.parseURL(feed.rss_url);

        for (const item of parsed.items) {
          await pool.query(
            `
            INSERT INTO news_articles (
              source_id,
              primary_city_id,
              title,
              url,
              summary,
              content,
              published_at,
              ingested_at,
              raw_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
            ON CONFLICT (url) DO NOTHING
            `,
            [
              feed.id,
              feed.primary_city_id,
              item.title || null,
              item.link || null,
              item.contentSnippet || item.description || null,
              item.content || null,
              item.pubDate ? new Date(item.pubDate) : null,
              JSON.stringify(item)
            ]
          );
        }

        console.log(`Finished: ${feed.rss_url}`);
      } catch (err) {
        console.error(`Error fetching ${feed.rss_url}:`, err.message);
      }
    }

    console.log("RSS fetch complete.");
  } catch (err) {
    console.error("Fatal fetch error:", err.message);
  }
}

module.exports = fetchFeeds;
