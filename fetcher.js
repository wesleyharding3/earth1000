require("dotenv").config();
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; RSSFetcher/1.0; +https://yoursite.com)",
    "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, */*"
  },
  defaultRSS: 2.0,
  xml2js: {
    strict: false,
    normalize: true,
    normalizeTags: true
  }
});

function cleanText(text) {
  return text?.replace(/<[^>]*>/g, "").trim();
}

async function logFeedError(feed, err, type = "RSS_FETCH_ERROR") {
  try {
    console.error("❌ RSS ERROR:", {
      feed_id: feed.id,
      rss_url: feed.rss_url,
      error_type: type,
      message: err.message,
      timestamp: new Date().toISOString()
    });

    await pool.query(
      `INSERT INTO rss_error_logs (feed_id, rss_url, error_type, error_message, stack_trace)
       VALUES ($1,$2,$3,$4,$5)`,
      [feed.id, feed.rss_url, type, err.message?.substring(0, 1000) || null, err.stack?.substring(0, 5000) || null]
    );

    await pool.query(
      `UPDATE news_sources SET last_error = $1, last_failed_at = NOW() WHERE id = $2`,
      [err.message?.substring(0, 1000), feed.id]
    );
  } catch (logErr) {
    console.error("🚨 CRITICAL: Failed to log RSS error:", logErr);
  }
}

function extractImage(item) {
  const enclosure = item.enclosure || item.enclosures;
  if (enclosure) {
    const list = Array.isArray(enclosure) ? enclosure : [enclosure];
    for (const e of list) {
      const url  = e?.url || e?.$?.url;
      const type = e?.type || e?.$?.type;
      if (url && (!type || type.startsWith("image/"))) return url;
    }
  }

  const mediaContent = item["media:content"] || item.mediacontent;
  if (mediaContent) {
    const media = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
    const url = media?.url || media?.$?.url;
    if (url) return url;
  }

  const mediaThumb = item["media:thumbnail"] || item.mediathumbnail;
  if (mediaThumb) {
    const thumb = Array.isArray(mediaThumb) ? mediaThumb[0] : mediaThumb;
    const url = thumb?.url || thumb?.$?.url;
    if (url) return url;
  }

  const html =
    item.contentEncoded ||
    item.contentencoded ||
    item["content:encoded"] ||
    item.content ||
    item.description;

  if (html) {
    const $ = cheerio.load(html);
    const featured = $(".wp-block-gutenberg-custom-blocks-featured-media").first().attr("src");
    if (featured) return featured;
    const firstImg = $("img").first().attr("src");
    if (firstImg) return firstImg;
  }

  return null;
}

async function fetchFeeds() {
  console.log("Starting RSS fetch...");

  const feedResult = await pool.query(`
    SELECT ns.id, ns.country_id, ns.rss_url, ns.city_id, ns.failure_count
    FROM news_sources ns
    WHERE ns.is_active = true
  `);

  const feeds = feedResult.rows;

  for (const feed of feeds) {
    try {
      if (!feed.rss_url) continue;
      console.log(`Fetching: ${feed.rss_url}`);

      const parsed = await Promise.race([
        parser.parseURL(feed.rss_url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Feed timeout")), 15000)
        )
      ]);

      if (!parsed.items || parsed.items.length === 0) {
        console.warn(`⚠️  No items found in feed: ${feed.rss_url}`);
        continue;
      }

      const items = parsed.items.slice(0, 40);

      for (const item of items) {
        const title       = cleanText(item.title);
        const summary     = cleanText(item.contentSnippet || item.description);
        const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
        const imageUrl    = extractImage(item);

        await pool.query(
          `INSERT INTO news_articles (
            source_id, city_id, country_id,
            title, url, summary, content,
            published_at, ingested_at, raw_json, image_url
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10)
          ON CONFLICT (url)
          DO UPDATE SET
            image_url = COALESCE(EXCLUDED.image_url, news_articles.image_url)`,
          [
            feed.id, feed.city_id, feed.country_id,
            title, item.link || null, summary, item.content || null,
            publishedAt, JSON.stringify(item), imageUrl
          ]
        );
      }

      await pool.query(
        `UPDATE news_sources SET failure_count = 0, last_success_at = NOW(), last_error = NULL WHERE id = $1`,
        [feed.id]
      );

      console.log(`✅ Finished: ${feed.rss_url}`);

    } catch (err) {
      await logFeedError(feed, err);

      await pool.query(
        `UPDATE news_sources SET failure_count = COALESCE(failure_count,0) + 1, last_failed_at = NOW() WHERE id = $1`,
        [feed.id]
      );

      await pool.query(
        `UPDATE news_sources SET is_active = false WHERE id = $1 AND failure_count >= 10`,
        [feed.id]
      );
    }
  }

  console.log("RSS fetch complete.");
}

module.exports = fetchFeeds;