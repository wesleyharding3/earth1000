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

// Use a current real-browser UA. Earlier "Earth00Bot/1.0" flagged
// every request to YouTube's edge as automated traffic, which (combined
// with hitting 250 endpoints back-to-back from a single Render IP)
// triggered per-IP throttling that surfaced as 404/500 floods. A
// realistic UA + slower cadence + retry-on-blip dramatically improves
// the hit rate without exposing us to YouTube's anti-scraping logic.
const REAL_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const parser = new Parser({
  headers: {
    'User-Agent':      REAL_BROWSER_UA,
    'Accept':          'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
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

// Cloudflare Worker proxy support. When YOUTUBE_RSS_PROXY env var is
// set, rewrite the YouTube RSS URL through it. CF's edge IPs aren't in
// YouTube's bot penalty box that Render's IP range sits in, so the
// proxy lifts the failure rate from ~85% back to ~5-15%. The Worker
// itself is open-source (yt-rss-proxy.js in the repo) and adds 5-min
// edge caching for free.
const RSS_PROXY_BASE = (process.env.YOUTUBE_RSS_PROXY || '').replace(/\/+$/, '');
function _rewriteToProxy(rssUrl) {
  if (!RSS_PROXY_BASE) return rssUrl;
  // Only rewrite YouTube feed URLs — leave anything else alone.
  const m = String(rssUrl || '').match(/^https?:\/\/www\.youtube\.com\/feeds\/videos\.xml\?(.+)$/i);
  if (!m) return rssUrl;
  return `${RSS_PROXY_BASE}/?${m[1]}`;
}

// Helper: extract HTTP status from rss-parser's "Status code <N>" message.
function _httpStatusFromError(err) {
  const m = String(err?.message || '').match(/status code[: ]+(\d{3})/i);
  return m ? parseInt(m[1], 10) : null;
}

// Multi-attempt fetch with exponential backoff. YouTube's RSS edge
// servers flap 200 → 404 → 200 even with the CF Worker proxy in
// front, and certain rate-limit-induced 404 windows last 5-30s.
// Single-retry-after-1s caught roughly half; three attempts with
// 1s → 5s → 15s spans most cooldown windows. Total worst-case
// wait per source: ~21s — still well inside the 1500ms+ inter-source
// delay budget for a 250-source run (~6-8 min).
//
// Retryable: 404, 408, 425, 429, 500, 502, 503, 504. Non-retryable
// (4xx that won't change with another try): 401, 403, 410, 451.
// Non-HTTP errors (DNS, parse failures, connection resets) are
// retried — they're almost always transient too.
//
// Returns an object: { feed, lastStatus, attempts } on success,
// throws { error, lastStatus, attempts } on final failure (status
// is exposed so the main loop can adapt pacing on rate-limit bursts).
async function fetchFeedWithRetry(rssUrl) {
  const url = _rewriteToProxy(rssUrl);
  const BACKOFFS_MS = [1000, 5000, 15000];   // wait BEFORE attempts 2,3,4
  const NON_RETRYABLE_HTTP = new Set([401, 403, 410, 451]);
  let lastErr = null;
  let lastStatus = null;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    if (attempt > 0) {
      // Jitter the backoff ±30% so a fleet of cron-coincident sources
      // doesn't synchronize their retries into a thundering herd.
      const base = BACKOFFS_MS[attempt - 1];
      const jitter = (Math.random() * 0.6 - 0.3) * base;
      await new Promise(r => setTimeout(r, Math.max(100, Math.round(base + jitter))));
    }
    try {
      const feed = await parser.parseURL(url);
      return { feed, lastStatus, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      lastStatus = _httpStatusFromError(err);
      // Stop early if HTTP says "this won't change on retry."
      if (lastStatus != null && NON_RETRYABLE_HTTP.has(lastStatus)) break;
    }
  }
  // Annotate the error so callers can read the final HTTP status
  // without re-parsing the message string.
  if (lastErr) {
    try { lastErr.lastHttpStatus = lastStatus; } catch (_) {}
    try { lastErr.attempts = BACKOFFS_MS.length + 1; } catch (_) {}
  }
  throw lastErr;
}

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
    const result = await fetchFeedWithRetry(source.rss_url);
    feed = result.feed;
  } catch (err) {
    await logError(source, err, "RSS_PARSE_ERROR");
    return {
      inserted: 0,
      skipped: 0,
      error: err.message,
      // Surface the final HTTP status so the main loop can detect
      // consecutive 404-cluster bursts and pause to let YouTube's
      // rate-limit window cool down.
      httpStatus: err.lastHttpStatus ?? null,
    };
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

  // Proxy URL-shape diagnostic. If YOUTUBE_RSS_PROXY is set, verify
  // the rewrite regex actually matches the first source's rss_url —
  // a silent regex miss is the #1 reason an env-var-set proxy still
  // fails: the proxy is configured, but every URL goes direct to
  // youtube.com because rss_url doesn't match
  // `^https?://www.youtube.com/feeds/videos.xml?…`. Common gotchas:
  // `m.youtube.com` (mobile), missing `www.`, RSS hosted under
  // `youtubei.googleapis.com`, or a custom YT-equivalent feed URL
  // that the source onboarding stored verbatim.
  if (RSS_PROXY_BASE && sources.length > 0) {
    const sample = sources[0].rss_url || '';
    const rewritten = _rewriteToProxy(sample);
    const proxyApplied = rewritten !== sample;
    console.log(`📺 Proxy: ${RSS_PROXY_BASE} | sample url rewritten: ${proxyApplied ? 'YES' : 'NO'}`);
    if (!proxyApplied) {
      console.warn(`📺 ⚠ Sample URL did NOT match the proxy rewrite regex — proxy is bypassed for this source. Sample: ${sample.slice(0, 120)}`);
    }
  } else if (!RSS_PROXY_BASE) {
    console.warn('📺 ⚠ YOUTUBE_RSS_PROXY not set — every request goes direct to youtube.com (high 404/500 failure rate expected from Render IP throttling).');
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let errors = 0;

  // Adaptive cooldown — when we see CONSECUTIVE_FAIL_THRESHOLD 404/5xx
  // in a row, pause for COOLDOWN_MS to let YouTube's rate-limit window
  // expire. Empirically, those bursts last 30-60s; a 60s pause spans
  // most of them. Resets on the next successful fetch.
  //
  // Without this, a run that hits a rate-limit window keeps pounding
  // at 1500ms intervals through 50-80 sources, all 404ing, before
  // YouTube cools off naturally — losing the entire bottom half of
  // the source list to artifacts of one bad cluster.
  const CONSECUTIVE_FAIL_THRESHOLD = 10;
  const COOLDOWN_MS = 60_000;
  let consecutiveFails = 0;

  for (const source of sources) {
    try {
      const result = await fetchChannel(source, stopwordCache);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      if (result.error) {
        errors++;
        // Count this as a consecutive failure only if it looks like
        // rate-limiting (HTTP 404 or 5xx). Treat non-HTTP errors (DNS,
        // parse failures) as failures too — they often co-occur with
        // network-level throttling.
        const s = result.httpStatus;
        if (s === null || s === 404 || (s >= 500 && s < 600)) {
          consecutiveFails++;
        } else {
          consecutiveFails = 0;
        }
      } else {
        consecutiveFails = 0;
      }

      // Adaptive cooldown trigger.
      if (consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
        console.warn(`📺 ⏸  ${consecutiveFails} consecutive failures — cooling down ${COOLDOWN_MS/1000}s to let YouTube rate-limit window expire`);
        await new Promise(r => setTimeout(r, COOLDOWN_MS));
        consecutiveFails = 0;
      }

      // Inter-channel delay. Bumped 500ms → 1500ms originally to defeat
      // YouTube's per-IP throttling. Now JITTERED 1500-3500ms so the
      // request cadence isn't perfectly periodic — periodic requests
      // are a strong bot-detection signal, even at slow rates. 0.4-0.7
      // req/sec average is well under YouTube's per-IP rate limit but
      // looks more like organic traffic.
      const delayMs = 1500 + Math.floor(Math.random() * 2000);
      await new Promise(r => setTimeout(r, delayMs));
    } catch (err) {
      console.error(`[YT:${source.channel_handle || source.channel_id}] Unexpected error:`, err.message);
      errors++;
      consecutiveFails++;
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
