require("dotenv").config();
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const pool = require("./db");
const { translateText } = require("./translator");
const crypto = require("crypto");

const TRANSLATION_ENABLED = false;

/* =========================================
   Parser Options
========================================= */
const parserOptions = {
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
};

/* =========================================
   Utilities
========================================= */
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
      `INSERT INTO rss_error_logs 
       (feed_id, rss_url, error_type, error_message, stack_trace)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        feed.id,
        feed.rss_url,
        type,
        err.message?.substring(0, 1000) || null,
        err.stack?.substring(0, 5000) || null
      ]
    );

    await pool.query(
      `UPDATE news_sources 
       SET last_error = $1, last_failed_at = NOW() 
       WHERE id = $2`,
      [err.message?.substring(0, 1000), feed.id]
    );
  } catch (logErr) {
    console.error("🚨 CRITICAL: Failed to log RSS error:", logErr);
  }
}

function buildFingerprint(item) {
  const base =
    (item.guid || "") +
    (item.link || "") +
    (item.isoDate || item.pubDate || "") +
    cleanText(item.title || "") +
    cleanText(item.contentSnippet || item.description || "");

  return crypto
    .createHash("sha256")
    .update(base)
    .digest("hex");
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

  const html =
    item.contentEncoded ||
    item.contentencoded ||
    item["content:encoded"] ||
    item.content ||
    item.description;

  if (html) {
    const $ = cheerio.load(html);
    const firstImg = $("img").first().attr("src");
    if (firstImg) return firstImg;
  }

  return null;
}

/* =========================================
   Controlled Fetch (Size-Limited)
========================================= */
const MAX_FEED_SIZE = 2 * 1024 * 1024;

async function fetchXmlWithLimit(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: parserOptions.headers
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();

    if (text.length > MAX_FEED_SIZE)
      throw new Error("Feed exceeds max size limit");

    return text;

  } catch (err) {
    if (err.name === "AbortError")
      throw new Error(`Timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================
   Main Fetch Function
========================================= */
async function fetchFeeds() {
  console.log("🚀 Starting RSS fetch...", new Date().toISOString());

  const feedResult = await pool.query(`
    SELECT ns.id, ns.country_id, ns.rss_url, ns.city_id,
           ns.failure_count, ns.language_id,
           l.iso_code_2 AS language
    FROM news_sources ns
    LEFT JOIN languages l ON l.id = ns.language_id
    WHERE ns.is_active = true
    AND (
      ns.last_checked_at IS NULL
      OR ns.last_checked_at < NOW() - INTERVAL '480 minutes'
    )
    ORDER BY ns.last_checked_at NULLS FIRST
    LIMIT 300
  `);

  const feeds = feedResult.rows;
  console.log(`📋 Feeds selected for this run: ${feeds.length}`);

  const parser = new Parser(parserOptions);

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const tag = `[${i + 1}/${feeds.length}]`;

    try {
      if (!feed.rss_url) continue;

      // 🔒 Mark immediately to prevent reprocessing if crash occurs
      await pool.query(
        `UPDATE news_sources
         SET last_checked_at = NOW()
         WHERE id = $1`,
        [feed.id]
      );

      console.log(`\n${tag} 🔄 Starting: ${feed.rss_url}`);

      const xml = await fetchXmlWithLimit(feed.rss_url, 15000);
      const parsed = await parser.parseString(xml);

      if (!parsed.items || parsed.items.length === 0) {
        console.warn(`${tag} ⚠️ No items found.`);
        continue;
      }

      const isNonEnglish =
        feed.language && feed.language.toUpperCase() !== "EN";

      let MAX_ITEMS = !isNonEnglish
        ? 25
        : TRANSLATION_ENABLED
          ? 3
          : 10;

      const items = parsed.items.slice(0, MAX_ITEMS);

      let inserted = 0;

      for (const item of items) {
        const fingerprint = buildFingerprint(item);

        // 🔎 Check if article already exists (early-exit optimization)
        const existsResult = await pool.query(
          `SELECT 1
           FROM news_articles
           WHERE url = $1
           LIMIT 1`,
          [fingerprint]
        );

        if (existsResult.rowCount > 0) {
          console.log(`${tag} ⏹ Encountered existing article → stopping early`);
          break; // Stop processing THIS feed only
        }

        const title = cleanText(item.title);
        const summary = cleanText(item.contentSnippet || item.description);
        let publishedAt = null;
        if (item.isoDate) {
          const d = new Date(item.isoDate);
          if (!isNaN(d.getTime())) publishedAt = d;
          } else if (item.pubDate) {
            const d = new Date(item.pubDate);
            if (!isNaN(d.getTime())) publishedAt = d;
          }


        const imageUrl = extractImage(item);

        let translatedTitle = title;
        let translatedSummary = summary;

        if (
          TRANSLATION_ENABLED &&
          feed.language &&
          feed.language.toUpperCase() !== "EN"
        ) {
          translatedTitle = await translateText(title, "EN-US");
          translatedSummary = await translateText(summary, "EN-US");
        }

        const insertResult = await pool.query(
          `INSERT INTO news_articles (
             source_id,
             city_id,
             country_id,
             title,
             translated_title,
             url,
             article_url,
             summary,
             translated_summary,
             content,
             published_at,
             ingested_at,
             image_url
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11
           )
           ON CONFLICT (url)
           DO NOTHING`,
          [
            feed.id,
            feed.city_id,
            feed.country_id,
            title,
            translatedTitle,
            fingerprint,
            item.link || null,
            summary,
            translatedSummary,
            item.content || null,
            publishedAt,
            imageUrl
          ]
        );

        if (insertResult.rowCount > 0) {
          inserted++;
        }
      }

      await pool.query(
        `UPDATE news_sources 
         SET failure_count = 0,
             last_success_at = NOW(),
             last_error = NULL
         WHERE id = $1`,
        [feed.id]
      );

      console.log(`${tag} ✅ Inserted: ${inserted}`);

    } catch (err) {
      console.error(`${tag} ❌ Failed: ${err.message}`);

      await logFeedError(feed, err);

      await pool.query(
        `UPDATE news_sources 
         SET failure_count = COALESCE(failure_count,0) + 1,
             last_failed_at = NOW()
         WHERE id = $1`,
        [feed.id]
      );

      await pool.query(
        `UPDATE news_sources 
         SET is_active = false 
         WHERE id = $1 AND failure_count >= 10`,
        [feed.id]
      );
    }
  }

  console.log("🏁 RSS fetch batch complete.");
}

module.exports = fetchFeeds;