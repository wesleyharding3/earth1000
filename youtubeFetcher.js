// Cap DB pool before any module loads ./db. YouTube fetcher is a
// standalone cron (Render runs it on its own schedule); mirror the
// fetcher/worker pattern so it can't crowd out the API pool.
process.env.DB_POOL_MAX = "6";

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

const INITIAL_YOUTUBE_BASE_PRIORITY = 1.15;

/* =========================================
   Utilities
========================================= */
function cleanText(text) {
  if (!text) return text;
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
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

// Classify a fetch error as either PERMANENT (channel is gone / unreachable in
// a way that won't recover on retry) or TRANSIENT (timeouts, 5xx, rate limits,
// transient DNS hiccups — probably fine tomorrow).
//
// HISTORY: an earlier version classified 404, 403, 401, DNS-fail, and "invalid
// feed" as PERMANENT, which insta-deactivated sources on first hit. A single
// upstream YouTube/Google hiccup that returned 404s or 5xx en masse killed
// 2,500+ otherwise-healthy sources in one cron run. From the wreckage:
// "Status code 404" was the cause for 1,965 sources (most of which had been
// fetching successfully a week earlier — clearly transient). The classifier
// is now strict only on 410 GONE and explicit textual terminations from
// YouTube. Everything else falls through to the 5-strike counter, which
// gives 5 cron runs to recover before deactivation.
function classifyYouTubeError(err) {
  const msg = String(err?.message || '').toLowerCase();
  // rss-parser surfaces HTTP status as "Status code <N>" in the message.
  const statusMatch = msg.match(/status code[: ]+(\d{3})/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
  // 410 GONE is the only HTTP code that genuinely means "this resource is
  // permanently unavailable." Everything else (404/403/401/5xx, DNS, RSS
  // parse errors) falls through to the 5-strike counter — too many of
  // those fire transiently from YouTube's edge servers, regional bot
  // detection, and rate-limit responses to be insta-killers.
  if (status === 410) return 'PERMANENT';
  // Explicit textual "channel terminated/deleted/not found" signals from
  // YouTube's RSS endpoint stay PERMANENT. Those are unambiguous.
  if (/channel\s*(terminated|deleted|does\s*not\s*exist)/i.test(msg)) return 'PERMANENT';
  return 'TRANSIENT';
}

async function logError(source, err, type = "YOUTUBE_FETCH_ERROR") {
  try {
    const kind = classifyYouTubeError(err);
    console.error("❌ YouTube ERROR:", {
      source_id: source.id,
      channel_id: source.channel_id,
      name: source.name,
      error_type: type,
      classification: kind,
      message: err.message,
      timestamp: new Date().toISOString()
    });

    // Permanent errors → deactivate immediately and stamp last_error with a
    // human-readable note so we can audit later. Transient errors fall
    // through to the 5-strike counter as before.
    if (kind === 'PERMANENT') {
      // Stamp last_checked_at too so the rotation (sorted by
      // last_checked_at ASC NULLS FIRST) doesn't keep picking the same
      // bad source first on every run.
      await pool.query(
        `UPDATE youtube_sources
           SET last_error      = $1,
               last_failed_at  = NOW(),
               last_checked_at = NOW(),
               failure_count   = failure_count + 1,
               is_active       = false
         WHERE id = $2`,
        [`[AUTO-DEACTIVATED: ${type}] ${err.message?.substring(0, 960) || ''}`.substring(0, 1000), source.id]
      );
      console.warn(`   ⛔ Auto-deactivated youtube_source ${source.id} (${source.name}) — permanent error`);
      return;
    }

    // Same rotation-trap fix on the transient path. Without stamping
    // last_checked_at, an erroring source stays at the front of the
    // ORDER BY queue and re-fires every cron run, denying healthy
    // sources their turn.
    await pool.query(
      `UPDATE youtube_sources
         SET last_error      = $1,
             last_failed_at  = NOW(),
             last_checked_at = NOW(),
             failure_count   = failure_count + 1,
             is_active       = CASE WHEN failure_count + 1 >= 5 THEN false ELSE is_active END
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
           media_type, video_id, base_priority
         ) VALUES (
           NULL, $1, $2, $3,
           $4, $5, $6,
           $7, $8, NOW(),
           $9, $10,
           'video', $11, $12
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
          videoId,
          INITIAL_YOUTUBE_BASE_PRIORITY
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

        // Hand off to articleListener for the full pipeline:
        // classify → route (article_locations) → image resolution.
        // Fire-and-forget, same pattern as fetcher.js.
        pool.query("SELECT pg_notify('new_article', $1::text)", [String(articleId)])
          .catch(err => console.warn(`${tag} pg_notify failed for article ${articleId}:`, err.message));
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

  // Get active YouTube sources. Capped at MAX_PER_RUN so a fleet of
  // ~2,500 active sources (post-recovery) doesn't turn a single cron
  // tick into a 4-hour run that times out and traps the rotation.
  // ORDER BY last_checked_at picks the staletest sources first, so
  // every source gets fetched roughly every (MAX_PER_RUN / total)
  // runs. With MAX_PER_RUN=250 and 2,500 sources, that's ~10 cron
  // runs (~10h on hourly cron) for a full sweep — acceptable since
  // YouTube channels rarely publish more than a few times per day.
  const MAX_PER_RUN = parseInt(process.env.YOUTUBE_FETCH_MAX_PER_RUN || '250', 10);
  const { rows: sources } = await pool.query(`
    SELECT
      ys.id, ys.name, ys.channel_id, ys.channel_handle,
      ys.site_url, ys.rss_url, ys.city_id, ys.country_id,
      ys.language
    FROM youtube_sources ys
    WHERE ys.is_active = true
    ORDER BY ys.last_checked_at ASC NULLS FIRST
    LIMIT $1
  `, [MAX_PER_RUN]);

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
      // Unexpected errors at the top level bypass fetchChannel's internal
      // logError call. Route them through the same classifier so a
      // permanently-broken channel still gets auto-deactivated instead of
      // sitting at failure_count=0 forever.
      try {
        await logError(source, err, "YOUTUBE_UNEXPECTED_ERROR");
      } catch (_) {}
    }
  }

  console.log(`📺 YouTube fetch complete: +${totalInserted} new, ${totalSkipped} skipped, ${errors} errors`);
}

/* =========================================
   Run
========================================= */
fetchYouTube()
  .then(async () => {
    console.log("📺 YouTube fetcher finished");
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("📺 YouTube fetcher crashed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
