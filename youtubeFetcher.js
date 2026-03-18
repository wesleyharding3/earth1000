require("dotenv").config();
const Parser = require("rss-parser");
const pool = require("./db");
const { loadStopwords, extractKeywords, saveKeywords } = require("./keywordExtractor");

/* =========================================
   YouTube RSS Fetcher
   
   Fetches videos from YouTube channels via RSS.
   YouTube RSS URL format:
   https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID
   
   Cron: Every 2-4 hours (videos publish less frequently than news)
========================================= */

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; Earth00Bot/1.0)"
  },
  customFields: {
    item: [
      ["yt:videoId", "videoId"],
      ["yt:channelId", "channelId"],
      ["media:group", "mediaGroup"],
      ["media:thumbnail", "thumbnail"],
      ["media:description", "mediaDescription"],
      ["media:content", "mediaContent"]
    ]
  }
});

/* =========================================
   Utilities
========================================= */
function cleanText(text) {
  return text?.replace(/<[^>]*>/g, "").trim();
}

function truncateAtWord(text, limit = 500) {
  if (!text || text.length <= limit) return text;
  const truncated = text.substring(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace === -1) return truncated + "...";
  return truncated.substring(0, lastSpace) + "...";
}

// Extract best thumbnail URL from YouTube feed item
function extractThumbnail(item) {
  // Try media:group -> media:thumbnail first
  if (item.mediaGroup?.["media:thumbnail"]?.[0]?.$?.url) {
    return item.mediaGroup["media:thumbnail"][0].$.url;
  }
  // Try direct media:thumbnail
  if (item.thumbnail?.$?.url) {
    return item.thumbnail.$.url;
  }
  // Fallback: construct from video ID
  if (item.videoId) {
    return `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  }
  return null;
}

// Extract description from various possible locations
function extractDescription(item) {
  if (item.mediaGroup?.["media:description"]?.[0]) {
    return cleanText(item.mediaGroup["media:description"][0]);
  }
  if (item.mediaDescription) {
    return cleanText(item.mediaDescription);
  }
  if (item.contentSnippet) {
    return cleanText(item.contentSnippet);
  }
  if (item.content) {
    return cleanText(item.content);
  }
  return null;
}

async function logError(source, err, type = "YOUTUBE_FETCH_ERROR") {
  try {
    console.error("❌ YouTube ERROR:", {
      source_id: source.id,
      channel_id: source.channel_id,
      name: source.name,
      error_type: type,
      message: err.message,
      timestamp: new Date().toISOString()
    });

    await pool.query(
      `UPDATE youtube_sources 
       SET last_error = $1, last_failed_at = NOW(),
           failure_count = failure_count + 1,
           is_active = CASE WHEN failure_count + 1 >= 5 THEN false ELSE is_active END
       WHERE id = $2`,
      [err.message?.substring(0, 1000), source.id]
    );
  } catch (logErr) {
    console.error("🚨 CRITICAL: Failed to log YouTube error:", logErr);
  }
}

/* =========================================
   Fetch Single Channel
========================================= */
async function fetchChannel(source, stopwordCache) {
  const tag = `[YT:${source.channel_handle || source.channel_id}]`;
  
  if (!source.rss_url) {
    console.warn(`${tag} ⚠️  No RSS URL configured, skipping`);
    return { inserted: 0, skipped: 0 };
  }

  let feed;
  try {
    feed = await parser.parseURL(source.rss_url);
  } catch (err) {
    await logError(source, err, "RSS_PARSE_ERROR");
    return { inserted: 0, skipped: 0, error: err.message };
  }

  const items = feed.items || [];
  if (items.length === 0) {
    console.log(`${tag} No items in feed`);
    return { inserted: 0, skipped: 0 };
  }

  // Limit to 5 videos per source per fetch cycle
  const FETCH_LIMIT = 5;
  const limitedItems = items.slice(0, FETCH_LIMIT);
  if (items.length > FETCH_LIMIT) {
    console.log(`${tag} Processing ${FETCH_LIMIT} of ${items.length} items`);
  }

  let inserted = 0;
  let skipped = 0;

  for (const item of limitedItems) {
    const videoId = item.videoId || item.id?.split(":").pop();
    if (!videoId) {
      skipped++;
      continue;
    }

    // Check for duplicate by video_id
    const { rows: existing } = await pool.query(
      `SELECT id FROM news_articles WHERE video_id = $1 LIMIT 1`,
      [videoId]
    );
    
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const title = cleanText(item.title) || "Untitled Video";
    const description = extractDescription(item);
    const summary = truncateAtWord(description, 500);
    const thumbnail = extractThumbnail(item);
    const videoUrl = item.link || `https://www.youtube.com/watch?v=${videoId}`;
    const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();

    try {
      const { rows } = await pool.query(
        `INSERT INTO news_articles (
           source_id, youtube_source_id, city_id, country_id,
           title, url, article_url,
           summary, published_at, ingested_at,
           image_url, language,
           media_type, video_id
         ) VALUES (
           NULL, $1, $2, $3,
           $4, $5, $6,
           $7, $8, NOW(),
           $9, $10,
           'video', $11
         )
         RETURNING id`,
        [
          source.id, // youtube_source_id
          source.city_id,
          source.country_id,
          title,
          videoUrl,
          videoUrl,
          summary,
          publishedAt,
          thumbnail,
          source.language || "en",
          videoId
        ]
      );

      if (rows.length > 0) {
        inserted++;
        const articleId = rows[0].id;

        // Extract and save keywords
        try {
          const keywords = extractKeywords(
            { title, summary },
            source.language || "en",
            stopwordCache
          );
          if (keywords.length > 0) {
            await saveKeywords(
              articleId,
              keywords,
              source.language || "en",
              publishedAt,
              source.country_id,
              null
            );
          }
        } catch (kwErr) {
          console.warn(`${tag} Keyword extraction failed for article ${articleId}:`, kwErr.message);
        }
      }
    } catch (insertErr) {
      console.error(`${tag} Insert failed for ${videoId}:`, insertErr.message);
    }
  }

  // Update last_checked_at and clear failure state on success
  await pool.query(
    `UPDATE youtube_sources 
     SET last_checked_at = NOW(), 
         last_success_at = NOW(),
         failure_count = 0,
         last_error = NULL
     WHERE id = $1`,
    [source.id]
  );

  console.log(`${tag} ✅ +${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped };
}

/* =========================================
   Main Fetch Function
========================================= */
async function fetchYouTube() {
  console.log("📺 Starting YouTube fetch run...", new Date().toISOString());

  // Load stopwords for keyword extraction
  let stopwordCache;
  try {
    stopwordCache = await loadStopwords();
  } catch (err) {
    console.error("Failed to load stopwords:", err.message);
    stopwordCache = {};
  }

  // Get active YouTube sources
  const { rows: sources } = await pool.query(`
    SELECT 
      ys.id, ys.name, ys.channel_id, ys.channel_handle,
      ys.site_url, ys.rss_url, ys.city_id, ys.country_id,
      ys.language
    FROM youtube_sources ys
    WHERE ys.is_active = true
    ORDER BY ys.last_checked_at ASC NULLS FIRST
  `);

  console.log(`📺 Found ${sources.length} active YouTube sources`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let errors = 0;

  for (const source of sources) {
    try {
      const result = await fetchChannel(source, stopwordCache);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      if (result.error) errors++;
      
      // Small delay between channels to be polite
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[YT:${source.channel_handle || source.channel_id}] Unexpected error:`, err.message);
      errors++;
    }
  }

  console.log(`📺 YouTube fetch complete: +${totalInserted} new, ${totalSkipped} skipped, ${errors} errors`);
}

/* =========================================
   Run
========================================= */
fetchYouTube()
  .then(() => {
    console.log("📺 YouTube fetcher finished");
    process.exit(0);
  })
  .catch((err) => {
    console.error("📺 YouTube fetcher crashed:", err);
    process.exit(1);
  });