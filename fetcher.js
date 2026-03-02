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

function truncateAtWord(text, limit = 100) {
  if (!text || text.length <= limit) return text;
  const truncated = text.substring(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace === -1) return truncated + "...";
  return truncated.substring(0, lastSpace) + "...";
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
   Robust Date Parser
========================================= */
const DATE_FIELDS = [
  "isoDate",
  "pubDate",
  "published",
  "updated",
  "dc:date",
  "dcdate",
  "date",
  "created",
  "modified"
];

function parseRobustDate(raw) {
  if (!raw) return null;

  const cleaned = raw.trim()
    .replace(/\s+/g, " ")
    .replace(/,\s*(\d{1,2})\s+/, ", $1 ");

  // Attempt 1: native Date (handles ISO 8601 + RFC 2822)
  const d1 = new Date(cleaned);
  if (!isNaN(d1.getTime()) && d1.getFullYear() > 1970) return d1;

  // Attempt 2: strip day-of-week prefix ("Sun, " etc.)
  const stripped = cleaned.replace(/^[A-Za-z]{3},\s*/, "");
  const d2 = new Date(stripped);
  if (!isNaN(d2.getTime()) && d2.getFullYear() > 1970) return d2;

  // Attempt 3: normalise GMT/UTC suffix variants
  const normalised = cleaned
    .replace(/\bGMT\b/, "+0000")
    .replace(/\bUTC\b/, "+0000");
  const d3 = new Date(normalised);
  if (!isNaN(d3.getTime()) && d3.getFullYear() > 1970) return d3;

  // Attempt 4: extract a date-like substring and parse that
  const match = cleaned.match(
    /(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})[\sT]?(\d{2}:\d{2}(:\d{2})?)?(\s*[+-]\d{4}|\s*Z)?/
  );
  if (match) {
    const d4 = new Date(match[0]);
    if (!isNaN(d4.getTime()) && d4.getFullYear() > 1970) return d4;
  }

  return null;
}

function extractPublishedDate(item) {
  // Try all known date fields in priority order
  for (const field of DATE_FIELDS) {
    const val = item[field];
    if (!val) continue;
    const parsed = parseRobustDate(String(val));
    if (parsed) return parsed;
  }

  // Last resort: scan all string values on the item for anything date-like
  for (const val of Object.values(item)) {
    if (typeof val !== "string") continue;
    if (!/\d{4}/.test(val)) continue;
    if (val.length > 100) continue;
    const parsed = parseRobustDate(val);
    if (parsed) return parsed;
  }

  return null; // DB will COALESCE to NOW()
}

/* =========================================
   Translation with Timeout
========================================= */
async function translateWithTimeout(text, lang, timeoutMs = 10000) {
  if (!text) return text;
  return Promise.race([
    translateText(text, lang),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Translation timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

/* =========================================
   Controlled Fetch (Size-Limited)
========================================= */
const MAX_FEED_SIZE = 2 * 1024 * 1024;

async function fetchXmlWithLimit(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const fetchPromise = fetch(url, {
    signal: controller.signal,
    headers: parserOptions.headers
  });

  const response = await Promise.race([
    fetchPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Hard timeout after ${timeoutMs}ms`)), timeoutMs + 1000)
    )
  ]);

  clearTimeout(timeout);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_FEED_SIZE) throw new Error("Feed exceeds max size limit");
  return text;
}

/* =========================================
   Main Fetch Function
========================================= */
async function fetchFeeds() {
  console.log("🚀 Starting RSS fetch...", new Date().toISOString());
  const startTime = Date.now();

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
    LIMIT 5000
  `);

  const feeds = feedResult.rows;
  console.log(`📋 Feeds selected for this run: ${feeds.length}`);

  const parser = new Parser(parserOptions);

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const tag = `[${i + 1}/${feeds.length}] [${elapsed}s]`;

    try {
      if (!feed.rss_url) continue;

      await pool.query(
        `UPDATE news_sources
         SET last_checked_at = NOW()
         WHERE id = $1`,
        [feed.id]
      );

      console.log(`\n${tag} 🔄 Starting: ${feed.rss_url}`);

      let xml, parsed;

      try {
        xml = await fetchXmlWithLimit(feed.rss_url, 15000);
        parsed = await parser.parseString(xml);
      } catch (fetchErr) {
        console.error(`${tag} ❌ Fetch/parse failed: ${fetchErr.message}`);
        await logFeedError(feed, fetchErr);
        continue;
      }

      if (!parsed?.items || parsed.items.length === 0) {
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

      const candidateItems = parsed.items.slice(0, MAX_ITEMS * 3);

      const fingerprintMap = [];
      const fingerprints   = [];

      for (const item of candidateItems) {
        const fingerprint = buildFingerprint(item);
        fingerprintMap.push({ item, fingerprint });
        fingerprints.push(fingerprint);
      }

      const existingRes = await pool.query(
        `SELECT url FROM news_articles WHERE url = ANY($1)`,
        [fingerprints]
      );

      const existingSet = new Set(existingRes.rows.map(r => r.url));

      const newItems = [];

      for (const entry of fingerprintMap) {
        if (!existingSet.has(entry.fingerprint)) {
          newItems.push(entry);
        }
        if (newItems.length >= MAX_ITEMS) break;
      }

      let inserted = 0;

      for (const { item, fingerprint } of newItems) {

        const title = cleanText(item.title);
        const rawSummary = cleanText(item.contentSnippet || item.description);
        const summary = rawSummary
          ? truncateAtWord(rawSummary, 100)
          : null;

        const publishedAt = extractPublishedDate(item);

        const imageUrl = extractImage(item);

        let translatedTitle   = title;
        let translatedSummary = summary;

        if (TRANSLATION_ENABLED && isNonEnglish) {
          try {
            translatedTitle   = await translateWithTimeout(title, "EN-US");
            translatedSummary = await translateWithTimeout(summary, "EN-US");
          } catch (translateErr) {
            console.warn(`${tag} ⚠️ Translation failed, using original`);
          }
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
             image_url,
             language
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, NOW()), NOW(),$12,$13
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
            imageUrl,
            feed.language || null
          ]
        );

        if (insertResult.rowCount > 0) {
          inserted++;
        }
      }

      console.log(`${tag} ✅ Inserted: ${inserted}`);

    } catch (err) {
      console.error(`${tag} ❌ Failed: ${err.message}`);
      await logFeedError(feed, err);
    }
  }

  console.log("🏁 RSS fetch batch complete.");
}

module.exports = fetchFeeds;