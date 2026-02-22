require("dotenv").config();
const cheerio = require("cheerio");

console.log("ENV CHECK:", !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

const Parser = require("rss-parser");
const pool = require("./db");
const { TranslationServiceClient } = require("@google-cloud/translate");


// ===============================
// Google Translate v3 Config
// ===============================

let translationClient = null;
let PROJECT_ID = null;  

function getTranslationClient() {
  if (translationClient) return translationClient;

  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error("❌ GOOGLE_APPLICATION_CREDENTIALS_JSON is missing.");
    return null;
  }

  const credentials = JSON.parse(credentialsJson);
  PROJECT_ID = credentials.project_id;

  translationClient = new TranslationServiceClient({
    credentials,
    projectId: PROJECT_ID,
  });

  console.log("✅ Google Translation v3 client initialized. Project:", PROJECT_ID);
  return translationClient;
}



async function translateText(text, target = "en") {
  if (!text) return null;

  try {
    const client = getTranslationClient();
    if (!client) return null;

    const request = {
      parent: `projects/${PROJECT_ID}/locations/global`,
      contents: [text],
      mimeType: "text/plain",
      targetLanguageCode: target,
    };

    const [response] = await client.translateText(request);

    return response.translations?.[0]?.translatedText || null;

  } catch (err) {
    console.error("❌ Google v3 translation error:", err.message);
    return null;
  }
}

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

function extractImage(item) {

  // ===============================
  // 🥇 1. Standard RSS <enclosure>
  // ===============================
  const enclosure = item.enclosure || item.enclosures;
  if (enclosure) {
    const list = Array.isArray(enclosure) ? enclosure : [enclosure];

    for (const e of list) {
      const url  = e?.url || e?.$?.url;
      const type = e?.type || e?.$?.type;

      if (url && (!type || type.startsWith("image/"))) {
        return url;
      }
    }
  }

  // ===============================
  // 🥇 2. Media RSS <media:content>
  // ===============================
  const mediaContent =
    item["media:content"] ||
    item.mediacontent;

  if (mediaContent) {
    const media = Array.isArray(mediaContent)
      ? mediaContent[0]
      : mediaContent;

    const url = media?.url || media?.$?.url;
    if (url) return url;
  }

  // ===============================
  // 🥇 3. Media RSS <media:thumbnail>
  // ===============================
  const mediaThumb =
    item["media:thumbnail"] ||
    item.mediathumbnail;

  if (mediaThumb) {
    const thumb = Array.isArray(mediaThumb)
      ? mediaThumb[0]
      : mediaThumb;

    const url = thumb?.url || thumb?.$?.url;
    if (url) return url;
  }

  // ===============================
  // 🥈 4. Parse HTML Content
  // ===============================
  const html =
    item.contentEncoded ||
    item.contentencoded ||
    item["content:encoded"] ||
    item.content ||
    item.description;

  if (html) {
    const $ = cheerio.load(html);

    // Prefer WordPress featured image
    const featured =
      $(".wp-block-gutenberg-custom-blocks-featured-media")
        .first()
        .attr("src");

    if (featured) return featured;

    // Otherwise first image
    const firstImg = $("img").first().attr("src");
    if (firstImg) return firstImg;
  }

  return null;
}


// ===============================
// Main Fetch Function
// ===============================

async function fetchFeeds() {

// WHAT: Log Google Translate key status instead of DeepL
  // WHY:  DEEPL_API_KEY is undefined — referencing it here would throw
  //       a ReferenceError and abort the entire fetch run
  console.log("Starting RSS fetch...");
  console.log(
    "Google credentials loaded:",
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  );

const feedResult = await pool.query(`
  SELECT 
    ns.id, 
    ns.country_id, 
    ns.rss_url, 
    ns.city_id, 
    ns.failure_count,
    l.iso_code_2 AS language_code
  FROM news_sources ns
  LEFT JOIN languages l ON ns.language_id = l.id
  WHERE ns.is_active = true
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

      const items = parsed.items.slice(0, 40);

      const feedLanguage = feed.language_code || parsed.language || "unknown";

      for (const item of items) {


        const originalTitle = cleanText(item.title);
        const originalSummary =
          cleanText(item.contentSnippet || item.description);

        const publishedAt =
          item.pubDate ? new Date(item.pubDate) : null;
        const imageUrl = extractImage(item);  

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
          [translatedTitle, translatedSummary] = await Promise.all([
            translateText(originalTitle, "en"),
            translateText(originalSummary, "en")
          ]);
        }

          if (translatedTitle)   console.log(`✅ Translated title [${feedLanguage}→en]: "${originalTitle?.slice(0,60)}" → "${translatedTitle?.slice(0,60)}"`);
          if (translatedSummary) console.log(`✅ Translated summary [${feedLanguage}→en]: ${translatedSummary?.slice(0,80)}…`);
        

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
              raw_json,
              image_url
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12, $13
            )
            ON CONFLICT (url)
            DO UPDATE SET
              translated_title   = COALESCE(EXCLUDED.translated_title, news_articles.translated_title),
              translated_summary = COALESCE(EXCLUDED.translated_summary, news_articles.translated_summary),
              image_url = COALESCE(EXCLUDED.image_url, news_articles.image_url)
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
              JSON.stringify(item),
              imageUrl
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