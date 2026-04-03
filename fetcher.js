require("dotenv").config();
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const pool = require("./db");
const crypto = require("crypto");
const { loadStopwords, extractKeywords, saveKeywords } = require("./keywordExtractor");
const Anthropic = require("@anthropic-ai/sdk");

const TRANSLATION_ENABLED = false;

// ── Claude Haiku client — used only for CJK keyword extraction ────────────────
// CJK (Chinese, Japanese, Korean) scripts have no word separators; the regex
// tokeniser falls back to character bigrams which are meaningless noise.
// For these languages we ask Haiku to return English keywords directly, which
// also eliminates any downstream normalization step (normalized_keyword = keyword).
const aiClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const CJK_EXTRACT_LANGS = new Set(["zh", "ja", "ko", "th", "km", "lo"]);
const FETCH_TIER_INTERVALS = {
  4: { label: "hourly",        intervalMinutes: 60 },
  3: { label: "twice-daily",   intervalMinutes: 12 * 60 },
  2: { label: "daily",         intervalMinutes: 24 * 60 },
  1: { label: "weekly",        intervalMinutes: 7 * 24 * 60 }
};
const FETCH_BOOTSTRAP_PHASES = {
  BASELINE: "baseline",
  TIER3_EVAL: "tier3_eval",
  TIER4_EVAL: "tier4_eval",
  STABLE: "stable"
};
const FETCH_TIER_SQL_INTERVAL = `
  CASE COALESCE(ns.fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}')
    WHEN '${FETCH_BOOTSTRAP_PHASES.BASELINE}' THEN INTERVAL '0 minutes'
    WHEN '${FETCH_BOOTSTRAP_PHASES.TIER3_EVAL}' THEN INTERVAL '12 hours'
    WHEN '${FETCH_BOOTSTRAP_PHASES.TIER4_EVAL}' THEN INTERVAL '60 minutes'
    ELSE CASE COALESCE(ns.fetch_tier, 1)
      WHEN 4 THEN INTERVAL '60 minutes'
      WHEN 3 THEN INTERVAL '12 hours'
      WHEN 2 THEN INTERVAL '24 hours'
      ELSE INTERVAL '7 days'
    END
  END
`;

async function extractKeywordsWithClaude(title, summary, articleId, publishedAt, countryId) {
  if (!aiClient) return;
  try {
    const text = [title, (summary || "").slice(0, 200)].filter(Boolean).join(" — ");
    const msg = await aiClient.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Extract 5-10 concise English news keywords from this article text. Return ONLY a JSON array of lowercase strings. Include named entities (people, places, organisations), core topics, and meaningful bigrams. No stopwords, no generic terms like "news" or "said".

Text: ${text}

JSON array only:`
      }]
    });

    let keywords;
    try { keywords = JSON.parse(msg.content[0].text.trim()); }
    catch { return; }
    if (!Array.isArray(keywords) || !keywords.length) return;

    // Shape into the format saveKeywords expects; mark normalized_keyword = keyword
    // so the normalization step in storyThreadBuilder skips them (already English).
    const shaped = keywords
      .filter(k => typeof k === "string" && k.length >= 2)
      .slice(0, 15)
      .map((keyword, i) => ({ keyword: keyword.toLowerCase(), frequency: 15 - i, is_bigram: keyword.includes(" ") }));

    await saveKeywords(articleId, shaped, "en", publishedAt, countryId, countryId);

    // Mark them as already normalized so storyThreadBuilder skips them
    const kws = shaped.map(k => k.keyword);
    if (kws.length) {
      await pool.query(
        `UPDATE article_keywords SET normalized_keyword = keyword
         WHERE article_id = $1 AND keyword = ANY($2)`,
        [articleId, kws]
      );
    }
  } catch (err) {
    // Non-fatal — keyword extraction failures never block ingestion
    console.warn(`  ⚠️  Claude keyword extraction failed [${articleId}]: ${err.message}`);
  }
}

/* =========================================
   Header Sets
   Full browser fingerprints dramatically reduce 403s.
   UA rotation sequence used when initial request is blocked.
========================================= */
const HEADERS_DESKTOP = {
  "User-Agent":                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language":           "en-US,en;q=0.5",
  "Accept-Encoding":           "gzip, deflate, br",
  "Cache-Control":             "max-age=0",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "Sec-Fetch-User":            "?1",
};

// Many news sites explicitly whitelist Googlebot in their WAF/CDN rules
const HEADERS_GOOGLEBOT = {
  "User-Agent":      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Designed for RSS — widely whitelisted by CMS platforms
const HEADERS_FEEDBOT = {
  "User-Agent": "FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)",
  "Accept":     "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
};

const HEADERS_MOBILE = {
  "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// Retry order when desktop headers get a 403
const RETRY_HEADERS_403 = [HEADERS_GOOGLEBOT, HEADERS_FEEDBOT, HEADERS_MOBILE];
const RETRY_UA_LABELS    = ["Googlebot", "FeedBot", "Mobile"];

/* =========================================
   Parser Options
========================================= */
const parserOptions = {
  headers: HEADERS_DESKTOP,
  defaultRSS: 2.0,
  xml2js: {
    strict: false,
    normalize: true,
    normalizeTags: true
  }
};

const HOST_MIN_INTERVAL_MS   = 2000;
const HOST_JITTER_MS         = 400;
const HOST_403_BACKOFF_MS    = 10 * 60 * 1000;
const HOST_429_BACKOFF_MS    = 15 * 60 * 1000;
const HOST_BACKOFF_CAP_MS    = 6 * 60 * 60 * 1000;
const CONDITIONAL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const hostThrottleState = new Map();
const conditionalRequestCache = new Map();

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

function resolvePath(obj, dotPath) {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getHostKey(rawUrl) {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

function getHostState(rawUrl) {
  const host = getHostKey(rawUrl);
  if (!host) return null;
  if (!hostThrottleState.has(host)) {
    hostThrottleState.set(host, {
      nextAllowedAt: 0,
      lastRequestAt: 0,
      consecutive403: 0,
      consecutive429: 0
    });
  }
  return hostThrottleState.get(host);
}

function withConditionalHeaders(rawUrl, headers = {}) {
  const cached = conditionalRequestCache.get(rawUrl);
  if (!cached) return headers;
  if (Date.now() - cached.storedAt > CONDITIONAL_CACHE_TTL_MS) {
    conditionalRequestCache.delete(rawUrl);
    return headers;
  }

  const nextHeaders = { ...headers };
  if (cached.etag) nextHeaders["If-None-Match"] = cached.etag;
  if (cached.lastModified) nextHeaders["If-Modified-Since"] = cached.lastModified;
  return nextHeaders;
}

function updateConditionalCache(rawUrl, response) {
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (!etag && !lastModified) return;

  conditionalRequestCache.set(rawUrl, {
    etag: etag || null,
    lastModified: lastModified || null,
    storedAt: Date.now()
  });
}

async function waitForHostThrottle(rawUrl) {
  const state = getHostState(rawUrl);
  if (!state) return false;

  const now = Date.now();
  const earliest = Math.max(
    state.nextAllowedAt || 0,
    (state.lastRequestAt || 0) + HOST_MIN_INTERVAL_MS
  );

  const waitMs = earliest - now;

  if (waitMs > 0) {
    console.log(`⏭ Skipping ${getHostKey(rawUrl)} — cooldown ${(waitMs / 1000).toFixed(1)}s`);
    return true; // 🚫 signal skip
  }

  return false;
}

function noteHostResult(rawUrl, status, responseHeaders = null) {
  const state = getHostState(rawUrl);
  if (!state) return;

  const now = Date.now();
  const jitter = Math.floor(Math.random() * HOST_JITTER_MS);
  state.lastRequestAt = now;
  state.nextAllowedAt = Math.max(state.nextAllowedAt || 0, now + HOST_MIN_INTERVAL_MS + jitter);

  if (status === 403) {
    state.consecutive403 += 1;
    state.consecutive429 = 0;
    const backoffMs = Math.min(HOST_BACKOFF_CAP_MS, HOST_403_BACKOFF_MS * (2 ** (state.consecutive403 - 1)));
    state.nextAllowedAt = Math.max(state.nextAllowedAt, now + backoffMs);
    return;
  }

  if (status === 429) {
    state.consecutive429 += 1;
    state.consecutive403 = 0;
    const retryAfterHeader = responseHeaders?.get?.("retry-after");
    const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : null;
    const computedBackoff = retryAfterSeconds
      ? retryAfterSeconds * 1000
      : Math.min(HOST_BACKOFF_CAP_MS, HOST_429_BACKOFF_MS * (2 ** (state.consecutive429 - 1)));
    state.nextAllowedAt = Math.max(state.nextAllowedAt, now + computedBackoff);
    return;
  }

  if (status >= 200 && status < 400) {
    state.consecutive403 = 0;
    state.consecutive429 = 0;
  }
}

// opts.skipFailureIncrement — don't touch failure_count (used for 429 rate limits)
// opts.deactivateThreshold  — failures needed before auto-disable (default 5)
async function logFeedError(feed, err, type = "RSS_FETCH_ERROR", opts = {}) {
  const { skipFailureIncrement = false, deactivateThreshold = 5 } = opts;
  try {
    console.error("❌ ERROR:", {
      feed_id: feed.id,
      source_type: feed.source_type,
      url: feed.rss_url || feed.scrape_url,
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
        feed.rss_url || feed.scrape_url,
        type,
        err.message?.substring(0, 1000) || null,
        err.stack?.substring(0, 5000) || null
      ]
    );

    if (skipFailureIncrement) {
      // Just stamp the error — don't penalise the source (e.g. 429 rate-limit)
      await pool.query(
        `UPDATE news_sources SET last_error = $1, last_failed_at = NOW() WHERE id = $2`,
        [err.message?.substring(0, 1000), feed.id]
      );
    } else {
      await pool.query(
        `UPDATE news_sources
         SET last_error = $1, last_failed_at = NOW(),
             failure_count = failure_count + 1,
             is_active = CASE WHEN failure_count + 1 >= $3 THEN false ELSE is_active END
         WHERE id = $2`,
        [err.message?.substring(0, 1000), feed.id, deactivateThreshold]
      );
    }
  } catch (logErr) {
    console.error("🚨 CRITICAL: Failed to log error:", logErr);
  }
}

function buildFingerprint(item) {
  const base =
    (item.guid || "") +
    (item.link || "") +
    (item.isoDate || item.pubDate || "") +
    cleanText(item.title || "") +
    cleanText(item.contentSnippet || item.description || "");

  return crypto.createHash("sha256").update(base).digest("hex");
}

function fingerprintRaw(title, link) {
  return crypto
    .createHash("sha256")
    .update((title || "") + (link || ""))
    .digest("hex");
}

function normalizeFetchTier(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

function getFetchTierMeta(tier) {
  return FETCH_TIER_INTERVALS[tier] || FETCH_TIER_INTERVALS[1];
}

function normalizeFetchPhase(phase) {
  return Object.values(FETCH_BOOTSTRAP_PHASES).includes(phase)
    ? phase
    : FETCH_BOOTSTRAP_PHASES.BASELINE;
}

function getPhaseProgress(feed, phase) {
  if (phase === FETCH_BOOTSTRAP_PHASES.BASELINE) {
    return {
      runs: Number(feed.fetch_bootstrap_baseline_runs) || 0,
      emptyRuns: Number(feed.fetch_bootstrap_baseline_empty_runs) || 0
    };
  }
  if (phase === FETCH_BOOTSTRAP_PHASES.TIER3_EVAL) {
    return {
      runs: Number(feed.fetch_bootstrap_tier3_runs) || 0,
      emptyRuns: Number(feed.fetch_bootstrap_tier3_empty_runs) || 0
    };
  }
  if (phase === FETCH_BOOTSTRAP_PHASES.TIER4_EVAL) {
    return {
      runs: Number(feed.fetch_bootstrap_tier4_runs) || 0,
      emptyRuns: Number(feed.fetch_bootstrap_tier4_empty_runs) || 0
    };
  }
  return { runs: 0, emptyRuns: 0 };
}

async function applyBootstrapOutcome(feed, insertedCount) {
  const phase = normalizeFetchPhase(feed.fetch_bootstrap_phase);
  const hadNewItems = insertedCount > 0;
  const wasTier = normalizeFetchTier(feed.fetch_tier) || 4;
  let nextPhase = phase;
  let nextTier = wasTier;
  let movement = null;
  let reason = "";

  if (phase === FETCH_BOOTSTRAP_PHASES.BASELINE) {
    const nextRuns = (Number(feed.fetch_bootstrap_baseline_runs) || 0) + 1;
    const nextEmptyRuns = (Number(feed.fetch_bootstrap_baseline_empty_runs) || 0) + (hadNewItems ? 0 : 1);

    if (nextRuns >= 4) {
      if (nextEmptyRuns >= 4) {
        nextPhase = FETCH_BOOTSTRAP_PHASES.STABLE;
        nextTier = 1;
        movement = "down";
        reason = "baseline pass complete: 4/4 fetches returned nothing, moving source to weekly tier";
      } else {
        nextPhase = FETCH_BOOTSTRAP_PHASES.TIER3_EVAL;
        nextTier = 3;
        movement = wasTier === 3 ? null : (3 > wasTier ? "up" : "down");
        reason = `baseline pass complete: ${nextRuns - nextEmptyRuns}/${nextRuns} fetches produced articles, promoting source into twice-daily evaluation`;
      }
    } else {
      reason = `baseline warmup ${nextRuns}/4 (${nextRuns - nextEmptyRuns} hit, ${nextEmptyRuns} empty)`;
    }

    await pool.query(
      `UPDATE news_sources
          SET fetch_bootstrap_baseline_runs = $1,
              fetch_bootstrap_baseline_empty_runs = $2,
              fetch_bootstrap_phase = $3,
              fetch_tier = $4,
              fetch_tier_updated_at = NOW(),
              fetch_tier_last_changed_at = CASE
                WHEN COALESCE(fetch_tier, 4) <> $4 OR COALESCE(fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}') <> $3
                THEN NOW()
                ELSE fetch_tier_last_changed_at
              END,
              fetch_bootstrap_tier3_runs = CASE WHEN $3 = '${FETCH_BOOTSTRAP_PHASES.TIER3_EVAL}' THEN 0 ELSE fetch_bootstrap_tier3_runs END,
              fetch_bootstrap_tier3_empty_runs = CASE WHEN $3 = '${FETCH_BOOTSTRAP_PHASES.TIER3_EVAL}' THEN 0 ELSE fetch_bootstrap_tier3_empty_runs END
        WHERE id = $5`,
      [nextRuns, nextEmptyRuns, nextPhase, nextTier, feed.id]
    );

    return {
      phase,
      nextPhase,
      previousTier: wasTier,
      nextTier,
      movement,
      hadNewItems,
      runNumber: nextRuns,
      emptyRuns: nextEmptyRuns,
      reason
    };
  }

  if (phase === FETCH_BOOTSTRAP_PHASES.TIER3_EVAL) {
    const nextRuns = (Number(feed.fetch_bootstrap_tier3_runs) || 0) + 1;
    const nextEmptyRuns = (Number(feed.fetch_bootstrap_tier3_empty_runs) || 0) + (hadNewItems ? 0 : 1);

    if (nextRuns >= 4) {
      if (nextEmptyRuns >= 2) {
        nextPhase = FETCH_BOOTSTRAP_PHASES.STABLE;
        nextTier = 2;
        movement = "down";
        reason = `twice-daily evaluation complete: ${nextEmptyRuns}/4 empty fetches, moving source to daily tier`;
      } else {
        nextPhase = FETCH_BOOTSTRAP_PHASES.TIER4_EVAL;
        nextTier = 4;
        movement = "up";
        reason = `twice-daily evaluation complete: ${4 - nextEmptyRuns}/4 fetches produced articles, promoting source into hourly evaluation`;
      }
    } else {
      reason = `twice-daily evaluation ${nextRuns}/4 (${nextRuns - nextEmptyRuns} hit, ${nextEmptyRuns} empty)`;
    }

    await pool.query(
      `UPDATE news_sources
          SET fetch_bootstrap_phase = $1,
              fetch_tier = $2,
              fetch_tier_updated_at = NOW(),
              fetch_tier_last_changed_at = CASE
                WHEN COALESCE(fetch_tier, 4) <> $2 OR COALESCE(fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}') <> $1
                THEN NOW()
                ELSE fetch_tier_last_changed_at
              END,
              fetch_bootstrap_tier3_runs = $3,
              fetch_bootstrap_tier3_empty_runs = $4,
              fetch_bootstrap_tier4_runs = CASE WHEN $1 = '${FETCH_BOOTSTRAP_PHASES.TIER4_EVAL}' THEN 0 ELSE fetch_bootstrap_tier4_runs END,
              fetch_bootstrap_tier4_empty_runs = CASE WHEN $1 = '${FETCH_BOOTSTRAP_PHASES.TIER4_EVAL}' THEN 0 ELSE fetch_bootstrap_tier4_empty_runs END
        WHERE id = $5`,
      [nextPhase, nextTier, nextRuns, nextEmptyRuns, feed.id]
    );

    return {
      phase,
      nextPhase,
      previousTier: wasTier,
      nextTier,
      movement,
      hadNewItems,
      runNumber: nextRuns,
      emptyRuns: nextEmptyRuns,
      reason
    };
  }

  if (phase === FETCH_BOOTSTRAP_PHASES.TIER4_EVAL) {
    const nextRuns = (Number(feed.fetch_bootstrap_tier4_runs) || 0) + 1;
    const nextEmptyRuns = (Number(feed.fetch_bootstrap_tier4_empty_runs) || 0) + (hadNewItems ? 0 : 1);

    if (nextRuns >= 4) {
      nextPhase = FETCH_BOOTSTRAP_PHASES.STABLE;
      if (nextEmptyRuns >= 2) {
        nextTier = 3;
        movement = "down";
        reason = `hourly evaluation complete: ${nextEmptyRuns}/4 empty fetches, settling source into twice-daily tier`;
      } else {
        nextTier = 4;
        movement = null;
        reason = `hourly evaluation complete: source stayed productive on ${4 - nextEmptyRuns}/4 fetches, keeping hourly tier`;
      }
    } else {
      reason = `hourly evaluation ${nextRuns}/4 (${nextRuns - nextEmptyRuns} hit, ${nextEmptyRuns} empty)`;
    }

    await pool.query(
      `UPDATE news_sources
          SET fetch_bootstrap_phase = $1,
              fetch_tier = $2,
              fetch_tier_updated_at = NOW(),
              fetch_tier_last_changed_at = CASE
                WHEN COALESCE(fetch_tier, 4) <> $2 OR COALESCE(fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}') <> $1
                THEN NOW()
                ELSE fetch_tier_last_changed_at
              END,
              fetch_bootstrap_tier4_runs = $3,
              fetch_bootstrap_tier4_empty_runs = $4
        WHERE id = $5`,
      [nextPhase, nextTier, nextRuns, nextEmptyRuns, feed.id]
    );

    return {
      phase,
      nextPhase,
      previousTier: wasTier,
      nextTier,
      movement,
      hadNewItems,
      runNumber: nextRuns,
      emptyRuns: nextEmptyRuns,
      reason
    };
  }

  reason = `stable tier ${wasTier} (${getFetchTierMeta(wasTier).label})`;
  await pool.query(
    `UPDATE news_sources
        SET fetch_tier_updated_at = NOW()
      WHERE id = $1`,
    [feed.id]
  );

  return {
    phase,
    nextPhase,
    previousTier: wasTier,
    nextTier: wasTier,
    movement: null,
    hadNewItems,
    runNumber: null,
    emptyRuns: null,
    reason
  };
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
  "isoDate", "pubDate", "published", "updated",
  "dc:date", "dcdate", "date", "created", "modified"
];

function parseRobustDate(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  const now = new Date();

  // Cap future dates to today
  function capToToday(d) {
    if (d > now) return now;
    return d;
  }

  const d1 = new Date(cleaned);
  if (!isNaN(d1.getTime()) && d1.getFullYear() >= 2000 && d1.getFullYear() <= 2100) return capToToday(d1);

  const stripped = cleaned.replace(/^[A-Za-z]{3},\s*/, "");
  const d2 = new Date(stripped);
  if (!isNaN(d2.getTime()) && d2.getFullYear() >= 2000 && d2.getFullYear() <= 2100) return capToToday(d2);

  const normalised = cleaned.replace(/\bGMT\b/, "+0000").replace(/\bUTC\b/, "+0000");
  const d3 = new Date(normalised);
  if (!isNaN(d3.getTime()) && d3.getFullYear() >= 2000 && d3.getFullYear() <= 2100) return capToToday(d3);

  const match = cleaned.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\s+\w{3,}\s+\d{4})/);
  if (match) {
    const d4 = new Date(match[0]);
    if (!isNaN(d4.getTime()) && d4.getFullYear() >= 2000 && d4.getFullYear() <= 2100) return capToToday(d4);
  }

  return null;
}

function extractPublishedDate(item) {
  for (const field of DATE_FIELDS) {
    const val = item[field];
    if (!val) continue;
    const parsed = parseRobustDate(String(val));
    if (parsed) return parsed;
  }

  for (const val of Object.values(item)) {
    if (typeof val !== "string") continue;
    if (!/\d{4}/.test(val)) continue;
    if (val.length > 100) continue;
    const parsed = parseRobustDate(val);
    if (parsed) return parsed;
  }

  return null;
}

/* =========================================
   Controlled Fetch (Size-Limited, UA-Rotating)

   fetchWithRetry  — text response, retries with fallback UAs on 403
   fetchJsonWithRetry — JSON response, same retry logic
   discoverFeedUrl — tries homepage link discovery + common paths on 404
========================================= */
const MAX_FEED_SIZE = 2 * 1024 * 1024;

// Attach httpStatus so the main loop can differentiate without regex
function makeHttpError(status, attempt = 0) {
  const err = new Error(`HTTP ${status}${attempt > 0 ? ` (retry ${attempt})` : ""}`);
  err.httpStatus = status;
  return err;
}

async function _fetchRaw(url, headers, timeoutMs) {
  // 🚫 DO NOT WAIT — SKIP IF THROTTLED
  const isThrottled = await waitForHostThrottle(url);
  if (isThrottled) {
    const err = new Error("Host throttled");
    err.httpStatus = 429;
    throw err;
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestHeaders = withConditionalHeaders(url, headers);

    const response = await Promise.race([
      fetch(url, { signal: controller.signal, headers: requestHeaders }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Hard timeout after ${timeoutMs}ms`)), timeoutMs + 1000)
      )
    ]);

    noteHostResult(url, response.status, response.headers);

    if (response.ok || response.status === 304) {
      updateConditionalCache(url, response);
    }

    return response;

  } finally {
    clearTimeout(tid);
  }
}

async function fetchWithRetry(url, timeoutMs = 15000) {
  const allHeaders = [HEADERS_DESKTOP, ...RETRY_HEADERS_403];
  let lastErr;

  for (let attempt = 0; attempt < allHeaders.length; attempt++) {
    try {
      const response = await _fetchRaw(url, allHeaders[attempt], timeoutMs);

      if (response.ok) {
        if (attempt > 0) {
          console.log(`  ↩️  Unblocked on ${RETRY_UA_LABELS[attempt - 1]} UA (attempt ${attempt + 1})`);
        }
        const text = await response.text();
        if (text.length > MAX_FEED_SIZE) throw new Error("Feed exceeds max size limit");
        return text;
      }

      const status = response.status;

      if (status === 304) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(304, attempt);
      }

      // 🚫 HARD STOP — NO 403 RETRIES
      if (status === 403) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(403, attempt);
      }

      response.body?.cancel().catch(() => {});
      lastErr = makeHttpError(status, attempt);

      // everything else behaves the same
      throw lastErr;

    } catch (err) {
      if (err.httpStatus) {
        // 🚫 DO NOT RETRY 403
        throw err;
      }
      throw err;
    }
  }

  throw lastErr || makeHttpError(403);
}

async function fetchJsonWithRetry(url, timeoutMs = 15000) {
  const allHeaders = [HEADERS_DESKTOP, ...RETRY_HEADERS_403];
  let lastErr;

  for (let attempt = 0; attempt < allHeaders.length; attempt++) {
    try {
      const response = await _fetchRaw(url, allHeaders[attempt], timeoutMs);

      if (response.ok) {
        if (attempt > 0) {
          console.log(`  ↩️  Unblocked on ${RETRY_UA_LABELS[attempt - 1]} UA (attempt ${attempt + 1})`);
        }
        return response.json();
      }

      const status = response.status;

      if (status === 304) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(304, attempt);
      }

      // 🚫 HARD STOP — NO 403 RETRIES
      if (status === 403) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(403, attempt);
      }

      response.body?.cancel().catch(() => {});
      lastErr = makeHttpError(status, attempt);

      throw lastErr;

    } catch (err) {
      if (err.httpStatus) {
        // 🚫 DO NOT RETRY 403
        throw err;
      }
      throw err;
    }
  }

  throw lastErr || makeHttpError(403);
}

/* ─── Feed URL discovery (called on 404) ────────────────────────────────────
   1. Fetch origin homepage and look for <link rel="alternate" type="application/…+xml">
   2. Probe common feed path patterns with HEAD requests
   Returns the discovered URL string, or null if nothing found.
──────────────────────────────────────────────────────────────────────────── */
const FEED_PATH_CANDIDATES = [
  "/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml",
  "/?feed=rss2", "/feeds/posts/default", "/rss/index.xml",
  "/news/rss.xml", "/api/rss", "/index.xml", "/news/feed",
];

async function discoverFeedUrl(originalUrl) {
  let origin;
  try { origin = new URL(originalUrl).origin; } catch { return null; }

  // 1. Homepage <link rel="alternate"> discovery
  try {
    const res = await _fetchRaw(origin, HEADERS_DESKTOP, 10000);
    if (res.ok) {
      const html = await res.text();
      // Match both attribute orderings
      const m =
        html.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i) ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(rss|atom)\+xml["']/i);
      if (m) {
        const href = m[2] || m[1];
        const discovered = href.startsWith("http") ? href : new URL(href, origin).href;
        console.log(`  🔍 Feed discovered via <link rel=alternate>: ${discovered}`);
        return discovered;
      }
    }
  } catch (_) {}

  // 2. Probe common paths with HEAD requests
  for (const path of FEED_PATH_CANDIDATES) {
    try {
      const testUrl = origin + path;
      const r = await _fetchRaw(testUrl, HEADERS_FEEDBOT, 5000);
      const ct = r.headers?.get("content-type") || "";
      if (r.ok && (ct.includes("xml") || ct.includes("rss") || ct.includes("atom") || ct.includes("feed"))) {
        console.log(`  🔍 Feed discovered via path probe: ${testUrl} (${ct.split(";")[0]})`);
        return testUrl;
      }
      r.body?.cancel().catch(() => {});
    } catch (_) {}
  }

  return null;
}

/* =========================================
   Normalised Article Shape
   All fetchers return: Array<{
     title, summary, link, publishedAt, imageUrl, guid?
   }>
========================================= */

/* ── RSS / Atom / xml_feed ─────────────────────────────────── */
async function fetchRSSType(feed) {
  const parser = new Parser(parserOptions);
  const xml = await fetchWithRetry(feed.rss_url, 15000);
  const parsed = await parser.parseString(xml);
  if (!parsed?.items?.length) return [];

  return parsed.items.map(item => ({
    title:       cleanText(item.title),
    summary:     cleanText(item.contentSnippet || item.description),
    link:        item.link || null,
    publishedAt: extractPublishedDate(item),
    imageUrl:    extractImage(item),
    guid:        item.guid || item.link || null
  }));
}

/* ── news_sitemap / xml_sitemap ────────────────────────────── */
// Stream-parse: reads the response as chunks and stops as soon as we have
// SITEMAP_STREAM_MAX complete <url> blocks.  We never buffer the full file,
// so multi-MB sitemaps are handled cheaply — we cancel the download early.
const SITEMAP_STREAM_MAX = 100; // read at most this many <url> entries

async function fetchSitemap(feed) {
  const url  = feed.rss_url || feed.scrape_url;
  const items = [];

  // Try UA rotation on 403 before beginning the stream
  const allHeaders = [HEADERS_DESKTOP, ...RETRY_HEADERS_403];
  let response, lastSitemapErr;

  for (let attempt = 0; attempt < allHeaders.length; attempt++) {
    try {
      response = await _fetchRaw(url, allHeaders[attempt], 20000);
      if (response.ok) {
        if (attempt > 0) console.log(`  ↩️  Sitemap unblocked on ${RETRY_UA_LABELS[attempt - 1]} UA`);
        break;
      }
      if (response.status === 304) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(304, attempt);
      }
      response.body?.cancel().catch(() => {});
      lastSitemapErr = makeHttpError(response.status, attempt);
      if (response.status === 403 && attempt < allHeaders.length - 1) {
        console.log(`  🔄 Sitemap 403 (attempt ${attempt + 1}), retrying with ${RETRY_UA_LABELS[attempt]}…`);
        response = null;
        continue;
      }
      throw lastSitemapErr;
    } catch (err) {
      if (err.httpStatus === 403 && attempt < allHeaders.length - 1) { response = null; continue; }
      throw err;
    }
  }
  if (!response) throw lastSitemapErr || makeHttpError(403);

  try {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Pull out every complete <url>…</url> block from the buffer
      let start;
      while ((start = buffer.indexOf('<url>')) !== -1) {
        const end = buffer.indexOf('</url>', start);
        if (end === -1) break;               // incomplete block — wait for more data

        const block = buffer.slice(start, end + 6);
        buffer = buffer.slice(end + 6);

        // Extract fields with simple regex — no DOM parser needed
        const grab = (re) => (block.match(re) || [])[1]?.trim() || null;

        const link = grab(/<loc[^>]*>([\s\S]*?)<\/loc>/);
        if (!link) continue;

        const title = grab(/<news:title[^>]*>([\s\S]*?)<\/news:title>/)
                   || grab(/<title[^>]*>([\s\S]*?)<\/title>/);

        const dateRaw = grab(/<news:publication_date[^>]*>([\s\S]*?)<\/news:publication_date>/)
                     || grab(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/)
                     || grab(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);

        const imageUrl = grab(/<image:loc[^>]*>([\s\S]*?)<\/image:loc>/);

        items.push({
          title:       title || null,
          summary:     null,
          link,
          publishedAt: parseRobustDate(dateRaw),
          imageUrl,
          guid:        link,
        });

        if (items.length >= SITEMAP_STREAM_MAX) {
          // We have enough — cancel the rest of the download
          try { await reader.cancel(); } catch (_) {}
          break outer;
        }
      }
    }
  } catch (streamErr) {
    // Propagate stream errors (fetch timeout already cleared inside the retry loop above)
    throw streamErr;
  }

  return items;
}

/* ── html_list ──────────────────────────────────────────────
   Expects scrape_config:
   { list_selector, title_selector, link_selector,
     summary_selector?, date_selector?, date_attr?,
     image_selector?, base_url? }
─────────────────────────────────────────────────────────── */
async function fetchHtmlList(feed) {
  const cfg = feed.scrape_config || {};
  const html = await fetchWithRetry(feed.scrape_url, 20000);
  const $ = cheerio.load(html);
  const base = cfg.base_url || "";
  const items = [];

  $(cfg.list_selector || "article").each((_, el) => {
    const $el = $(el);

    const titleEl  = cfg.title_selector   ? $el.find(cfg.title_selector).first()   : $el.find("h2,h3,h4").first();
    const linkEl   = cfg.link_selector    ? $el.find(cfg.link_selector).first()    : titleEl;
    const summaryEl= cfg.summary_selector ? $el.find(cfg.summary_selector).first() : null;
    const dateEl   = cfg.date_selector    ? $el.find(cfg.date_selector).first()    : null;
    const imageEl  = cfg.image_selector   ? $el.find(cfg.image_selector).first()   : $el.find("img").first();

    const rawLink = linkEl.attr("href") || "";
    const link = rawLink.startsWith("http") ? rawLink : base + rawLink;
    const title = cleanText(titleEl.text());
    if (!title && !link) return;

    const dateRaw = dateEl
      ? (cfg.date_attr ? dateEl.attr(cfg.date_attr) : dateEl.text())
      : null;

    items.push({
      title,
      summary:     summaryEl ? cleanText(summaryEl.text()) : null,
      link:        link || null,
      publishedAt: parseRobustDate(dateRaw),
      imageUrl:    imageEl.attr("src") || imageEl.attr("data-src") || null,
      guid:        link || title
    });
  });

  return items;
}

/* ── html_roll (infinite-scroll / blog-roll style page) ─────
   Same config shape as html_list — just a semantic distinction.
   Scrapes the rendered static HTML (not headless).
─────────────────────────────────────────────────────────── */
async function fetchHtmlRoll(feed) {
  // Same logic as html_list; headless variant handled separately
  return fetchHtmlList(feed);
}

/* ── html_table ─────────────────────────────────────────────
   Expects scrape_config:
   { table_selector?, title_col (0-indexed int), link_col?,
     date_col?, summary_col?, base_url? }
─────────────────────────────────────────────────────────── */
async function fetchHtmlTable(feed) {
  const cfg = feed.scrape_config || {};
  const html = await fetchWithRetry(feed.scrape_url, 20000);
  const $ = cheerio.load(html);
  const base = cfg.base_url || "";
  const items = [];

  const table = cfg.table_selector ? $(cfg.table_selector).first() : $("table").first();

  table.find("tr").each((rowIdx, row) => {
    if (rowIdx === 0) return; // skip header row
    const cells = $(row).find("td");
    const titleIdx   = cfg.title_col   ?? 0;
    const linkIdx    = cfg.link_col    ?? cfg.title_col ?? 0;
    const dateIdx    = cfg.date_col    ?? null;
    const summaryIdx = cfg.summary_col ?? null;

    const titleCell = cells.eq(titleIdx);
    const linkCell  = cells.eq(linkIdx);

    const title   = cleanText(titleCell.text());
    const rawLink = linkCell.find("a").attr("href") || "";
    const link    = rawLink.startsWith("http") ? rawLink : base + rawLink;

    if (!title) return;

    items.push({
      title,
      summary:     summaryIdx !== null ? cleanText(cells.eq(summaryIdx).text()) : null,
      link:        link || null,
      publishedAt: dateIdx !== null ? parseRobustDate(cells.eq(dateIdx).text()) : null,
      imageUrl:    null,
      guid:        link || title
    });
  });

  return items;
}

/* ── mobile_html ────────────────────────────────────────────
   Fetches the mobile version of a page with a mobile UA.
   Falls back to html_list selectors from scrape_config.
─────────────────────────────────────────────────────────── */
async function fetchMobileHtml(feed) {
  // Mobile-first, but fall through to other UAs on 403
  const mobileFirst = [HEADERS_MOBILE, HEADERS_DESKTOP, HEADERS_GOOGLEBOT];
  const mobileLabels = ["Mobile", "Desktop", "Googlebot"];
  let html, lastMobileErr;

  for (let attempt = 0; attempt < mobileFirst.length; attempt++) {
    try {
      const response = await _fetchRaw(feed.scrape_url, mobileFirst[attempt], 20000);
      if (response.ok) {
        if (attempt > 0) console.log(`  ↩️  Mobile-html unblocked on ${mobileLabels[attempt]} UA`);
        html = await response.text();
        break;
      }
      const status = response.status;
      if (status === 304) {
        response.body?.cancel().catch(() => {});
        throw makeHttpError(304, attempt);
      }
      response.body?.cancel().catch(() => {});
      lastMobileErr = makeHttpError(status, attempt);
      if (status === 403 && attempt < mobileFirst.length - 1) {
        console.log(`  🔄 Mobile-html 403 (attempt ${attempt + 1}), retrying with ${mobileLabels[attempt + 1]}…`);
        continue;
      }
      throw lastMobileErr;
    } catch (err) {
      if (err.httpStatus === 403 && attempt < mobileFirst.length - 1) continue;
      throw err;
    }
  }
  if (!html) throw lastMobileErr || makeHttpError(403);

  // Reuse html_list parsing with the mobile HTML
  const cfg = feed.scrape_config || {};
  const $ = cheerio.load(html);
  const base = cfg.base_url || "";
  const items = [];

  $(cfg.list_selector || "article, .news-item, .article-item").each((_, el) => {
    const $el = $(el);
    const titleEl = cfg.title_selector ? $el.find(cfg.title_selector).first() : $el.find("h2,h3").first();
    const linkEl  = cfg.link_selector  ? $el.find(cfg.link_selector).first()  : titleEl;
    const rawLink = linkEl.attr("href") || "";
    const link    = rawLink.startsWith("http") ? rawLink : base + rawLink;
    const title   = cleanText(titleEl.text());
    if (!title) return;
    items.push({ title, summary: null, link: link || null, publishedAt: null, imageUrl: null, guid: link || title });
  });

  return items;
}

/* ── amp_list ───────────────────────────────────────────────
   AMP pages are just HTML — use the /amp/ or ?amp=1 variant.
   scrape_config same as html_list.
─────────────────────────────────────────────────────────── */
async function fetchAmpList(feed) {
  return fetchHtmlList(feed);
}

/* ── json_api ───────────────────────────────────────────────
   Expects scrape_config:
   { items_path, title_field, link_field,
     summary_field?, date_field?, image_field?,
     base_url? }
─────────────────────────────────────────────────────────── */
async function fetchJsonApi(feed) {
  const cfg = feed.scrape_config || {};
  const data = await fetchJsonWithRetry(feed.scrape_url || feed.rss_url);
  const rawItems = cfg.items_path ? resolvePath(data, cfg.items_path) : data;

  if (!Array.isArray(rawItems)) throw new Error("json_api: items_path did not resolve to an array");

  const base = cfg.base_url || "";

  return rawItems.map(item => {
    const rawLink = resolvePath(item, cfg.link_field || "url") || "";
    const link    = rawLink.startsWith("http") ? rawLink : base + rawLink;
    return {
      title:       cleanText(String(resolvePath(item, cfg.title_field   || "title")   || "")),
      summary:     cleanText(String(resolvePath(item, cfg.summary_field || "summary") || "")) || null,
      link:        link || null,
      publishedAt: parseRobustDate(String(resolvePath(item, cfg.date_field || "date") || "")),
      imageUrl:    resolvePath(item, cfg.image_field || "image") || null,
      guid:        link || resolvePath(item, "id") || null
    };
  });
}

/* ── archive_index ──────────────────────────────────────────
   Old-school archive pages (e.g. /news/archive/2024/03).
   Same config shape as html_list.
─────────────────────────────────────────────────────────── */
async function fetchArchiveIndex(feed) {
  return fetchHtmlList(feed);
}

/* ── headless_html ──────────────────────────────────────────
   JS-rendered pages — requires Puppeteer/Playwright on server.
   Stubs out gracefully if not available; log a clear warning.
─────────────────────────────────────────────────────────── */
async function fetchHeadlessHtml(feed) {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    throw new Error(
      "headless_html requires puppeteer (`npm i puppeteer`) — not installed on this server"
    );
  }

  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page    = await browser.newPage();
  await page.setUserAgent(parserOptions.headers["User-Agent"]);

  try {
    await page.goto(feed.scrape_url, { waitUntil: "networkidle2", timeout: 30000 });
    const html = await page.content();
    await browser.close();

    // Reuse html_list selectors
    const fakeFeed = { ...feed };
    const origFetch = fetchHtmlList;
    // Inject the already-fetched HTML by monkey-patching fetchWithLimit
    // Instead, parse inline:
    const cfg = feed.scrape_config || {};
    const $ = cheerio.load(html);
    const base = cfg.base_url || "";
    const items = [];

    $(cfg.list_selector || "article").each((_, el) => {
      const $el = $(el);
      const titleEl  = cfg.title_selector ? $el.find(cfg.title_selector).first() : $el.find("h2,h3").first();
      const linkEl   = cfg.link_selector  ? $el.find(cfg.link_selector).first()  : titleEl;
      const rawLink  = linkEl.attr("href") || "";
      const link     = rawLink.startsWith("http") ? rawLink : base + rawLink;
      const title    = cleanText(titleEl.text());
      if (!title) return;
      items.push({ title, summary: null, link: link || null, publishedAt: null, imageUrl: null, guid: link || title });
    });

    return items;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/* ── aggregator ─────────────────────────────────────────────
   Sources like Google News, AllSides, etc. that themselves
   aggregate. Treat as html_list with aggregator-specific defaults.
─────────────────────────────────────────────────────────── */
async function fetchAggregator(feed) {
  return fetchHtmlList(feed);
}

/* ── wechat_feed ────────────────────────────────────────────
   WeChat public accounts expose articles via mp.weixin.qq.com.
   Scrape_url should be the public account article list page.
   scrape_config same as html_list.
─────────────────────────────────────────────────────────── */
async function fetchWechatFeed(feed) {
  return fetchHtmlList(feed);
}

/* ── telegram_channel ───────────────────────────────────────
   Uses t.me/s/<channel> (the public preview page).
   scrape_url should be https://t.me/s/channelname
─────────────────────────────────────────────────────────── */
async function fetchTelegramChannel(feed) {
  const html = await fetchWithRetry(feed.scrape_url, 20000);
  const $ = cheerio.load(html);
  const items = [];

  $(".tgme_widget_message").each((_, el) => {
    const $el   = $(el);
    const text  = cleanText($el.find(".tgme_widget_message_text").text());
    const link  = $el.find(".tgme_widget_message_date").attr("href") || null;
    const dateRaw = $el.find("time").attr("datetime") || null;

    if (!text) return;
    // Use first sentence as title, rest as summary
    const dotIdx = text.indexOf(". ");
    const title   = dotIdx > 0 ? text.substring(0, dotIdx + 1) : text.substring(0, 120);
    const summary = dotIdx > 0 ? text.substring(dotIdx + 2)    : null;

    items.push({
      title,
      summary:     summary || null,
      link,
      publishedAt: parseRobustDate(dateRaw),
      imageUrl:    $el.find(".tgme_widget_message_photo_wrap").attr("style")
                     ?.match(/url\('(.+?)'\)/)?.[1] || null,
      guid:        link || text.substring(0, 80)
    });
  });

  return items;
}

/* ── site_search ────────────────────────────────────────────
   Hits a site's own search endpoint.
   scrape_config: { search_url_template, query, ... html_list selectors }
   e.g. search_url_template: "https://example.com/search?q={query}&sort=date"
─────────────────────────────────────────────────────────── */
async function fetchSiteSearch(feed) {
  const cfg = feed.scrape_config || {};
  const query = cfg.query || "news";
  const url   = (cfg.search_url_template || feed.scrape_url).replace("{query}", encodeURIComponent(query));
  const fakeFeed = { ...feed, scrape_url: url };
  return fetchHtmlList(fakeFeed);
}

/* =========================================
   Source Type → Fetcher Dispatch
========================================= */
const SOURCE_TYPE_EMOJI = {
  rss:              "📡",
  atom:             "📡",
  xml_feed:         "📡",
  news_sitemap:     "🗺️",
  xml_sitemap:      "🗺️",
  html_list:        "🌐",
  html_roll:        "🌐",
  html_table:       "📋",
  mobile_html:      "📱",
  amp_list:         "⚡",
  json_api:         "🔌",
  site_search:      "🔍",
  archive_index:    "📁",
  headless_html:    "🤖",
  aggregator:       "🗞️",
  wechat_feed:      "💬",
  telegram_channel: "✈️"
};

async function dispatchFetch(feed) {
  switch (feed.source_type) {
    case "rss":
    case "atom":
    case "xml_feed":
      return fetchRSSType(feed);

    case "news_sitemap":
    case "xml_sitemap":
      return fetchSitemap(feed);

    case "html_list":
      return fetchHtmlList(feed);

    case "html_roll":
      return fetchHtmlRoll(feed);

    case "html_table":
      return fetchHtmlTable(feed);

    case "mobile_html":
      return fetchMobileHtml(feed);

    case "amp_list":
      return fetchAmpList(feed);

    case "json_api":
      return fetchJsonApi(feed);

    case "site_search":
      return fetchSiteSearch(feed);

    case "archive_index":
      return fetchArchiveIndex(feed);

    case "headless_html":
      return fetchHeadlessHtml(feed);

    case "aggregator":
      return fetchAggregator(feed);

    case "wechat_feed":
      return fetchWechatFeed(feed);

    case "telegram_channel":
      return fetchTelegramChannel(feed);

    default:
      throw new Error(`Unknown source_type: "${feed.source_type}"`);
  }
}

/* =========================================
   Main Fetch Function
========================================= */
async function fetchFeeds(options = {}) {
  console.log(`🚀 Starting fetch run... ${new Date().toISOString()} [bootstrap-aware mode]`);
  const startTime = Date.now();

  let stopwordCache = null;
  try {
    stopwordCache = await loadStopwords();
  } catch (swErr) {
    console.warn("⚠️  Could not load stopwords — keyword extraction disabled:", swErr.message);
  }

  const feedResult = await pool.query(
    `
      SELECT ns.id, ns.name, ns.country_id, ns.rss_url, ns.scrape_url, ns.scrape_config,
             ns.city_id, ns.failure_count, ns.language_id, ns.popularity_tier,
             ns.source_type, COALESCE(ns.fetch_tier, 4) AS fetch_tier,
             COALESCE(ns.fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}') AS fetch_bootstrap_phase,
             COALESCE(ns.fetch_bootstrap_baseline_runs, 0) AS fetch_bootstrap_baseline_runs,
             COALESCE(ns.fetch_bootstrap_baseline_empty_runs, 0) AS fetch_bootstrap_baseline_empty_runs,
             COALESCE(ns.fetch_bootstrap_tier3_runs, 0) AS fetch_bootstrap_tier3_runs,
             COALESCE(ns.fetch_bootstrap_tier3_empty_runs, 0) AS fetch_bootstrap_tier3_empty_runs,
             COALESCE(ns.fetch_bootstrap_tier4_runs, 0) AS fetch_bootstrap_tier4_runs,
             COALESCE(ns.fetch_bootstrap_tier4_empty_runs, 0) AS fetch_bootstrap_tier4_empty_runs,
             ns.last_checked_at, ns.last_success_at,
             l.iso_code_2 AS language
      FROM news_sources ns
      LEFT JOIN languages l ON l.id = ns.language_id
      WHERE ns.is_active = true
        AND (
          ns.last_checked_at IS NULL
          OR ns.last_checked_at < NOW() - ${FETCH_TIER_SQL_INTERVAL}
        )
      ORDER BY
        CASE COALESCE(ns.fetch_bootstrap_phase, '${FETCH_BOOTSTRAP_PHASES.BASELINE}')
          WHEN '${FETCH_BOOTSTRAP_PHASES.BASELINE}' THEN 0
          WHEN '${FETCH_BOOTSTRAP_PHASES.TIER3_EVAL}' THEN 1
          WHEN '${FETCH_BOOTSTRAP_PHASES.TIER4_EVAL}' THEN 2
          ELSE 3
        END,
        COALESCE(ns.fetch_tier, 4) DESC,
        ns.last_checked_at NULLS FIRST
      LIMIT 10000
    `
  );

  const feeds = feedResult.rows;
  console.log(`📋 Feeds selected for this run: ${feeds.length}`);

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const sourceType = feed.source_type || "rss";
    const emoji      = SOURCE_TYPE_EMOJI[sourceType] || "❓";
    const url        = feed.rss_url || feed.scrape_url || "(no url)";
    const cadence    = getFetchTierMeta(feed.fetch_tier);
    const phase      = normalizeFetchPhase(feed.fetch_bootstrap_phase);
    const progress   = getPhaseProgress(feed, phase);
    const tag        = `[${i + 1}/${feeds.length}] [${elapsed}s]`;

    try {
      if (!feed.rss_url && !feed.scrape_url) {
        console.warn(`${tag} ⚠️  Skipping — no URL configured (source_type: ${sourceType})`);
        continue;
      }

      await pool.query(
        `UPDATE news_sources SET last_checked_at = NOW() WHERE id = $1`,
        [feed.id]
      );

      const phaseText = phase === FETCH_BOOTSTRAP_PHASES.STABLE
        ? `stable tier ${feed.fetch_tier} ${cadence.label}`
        : `${phase} ${progress.runs}/4`;
      console.log(`\n${tag} ${emoji} ${sourceType} — ${feed.name || "Unnamed source"} — ${url} [${phaseText}]`);

      let rawItems = [];
      try {
        rawItems = await dispatchFetch(feed);
        // Feed is reachable — mark success and reset consecutive failure count.
        await pool.query(
          `UPDATE news_sources
              SET last_success_at = NOW(),
                  failure_count = 0,
                  last_error = NULL
            WHERE id = $1`,
          [feed.id]
        );
      } catch (fetchErr) {
        const status = fetchErr.httpStatus;

        if (status === 304) {
          console.log(`${tag} ↪️  Not modified (304) — skipped fetch body via conditional request`);
          await pool.query(
            `UPDATE news_sources
                SET last_success_at = NOW(),
                    failure_count = 0,
                    last_error = NULL
              WHERE id = $1`,
            [feed.id]
          );
          continue;
        }

        // ── 429 Rate Limited ───────────────────────────────────────────────────
        // Server asked us to back off. Don't penalise the source — it's alive.
        if (status === 429) {
          console.warn(`${tag} ⏸️  Rate limited (429) — skipping without failure penalty`);
          await logFeedError(feed, fetchErr, "HTTP_429_RATE_LIMITED", { skipFailureIncrement: true });
          continue;
        }

        // ── 404 Not Found ─────────────────────────────────────────────────────
        // Feed URL may have moved. Attempt auto-discovery before counting failure.
        if (status === 404) {
          console.warn(`${tag} 🔍 404 — attempting feed auto-discovery for ${feed.name}…`);
          const originalUrl = feed.rss_url || feed.scrape_url;
          const newUrl = await discoverFeedUrl(originalUrl);

          if (newUrl && newUrl !== originalUrl) {
            const col = feed.rss_url ? "rss_url" : "scrape_url";
            await pool.query(
              `UPDATE news_sources
                  SET ${col} = $1,
                      last_error = NULL,
                      failure_count = 0
                WHERE id = $2`,
              [newUrl, feed.id]
            );
            console.log(`${tag} ✅ Feed URL updated: ${originalUrl} → ${newUrl} (will fetch next run)`);
          } else {
            console.error(`${tag} ❌ 404 — no replacement feed found`);
            await logFeedError(feed, fetchErr, "HTTP_404_NOT_FOUND");
          }
          continue;
        }

        // ── 403 Forbidden (all UAs exhausted) ─────────────────────────────────
        // Full retry sequence ran — site is actively blocking our IP/ASNs.
        // Count the failure but use a higher deactivation threshold (10 not 5)
        // since the feed is live, just geo/IP blocking us.
        if (status === 403) {
          console.error(`${tag} 🚫 403 blocked — all UA retries exhausted for ${feed.name}`);
          await logFeedError(feed, fetchErr, "HTTP_403_BLOCKED", { deactivateThreshold: 10 });
          continue;
        }

        // ── 5xx Server Error ──────────────────────────────────────────────────
        // Transient server-side problem. Count failure but use higher threshold
        // since the feed is likely coming back.
        if (status >= 500) {
          console.error(`${tag} ⚡ Server error (${status}) for ${feed.name}: ${fetchErr.message}`);
          await logFeedError(feed, fetchErr, `HTTP_${status}_SERVER_ERROR`, { deactivateThreshold: 8 });
          continue;
        }

        // ── Everything else (network timeout, parse error, etc.) ──────────────
        console.error(`${tag} ❌ Fetch/parse failed: ${fetchErr.message}`);
        await logFeedError(feed, fetchErr);
        continue;
      }

      if (!rawItems.length) {
        const tierStatus = await applyBootstrapOutcome(feed, 0);
        const movementNote = tierStatus.movement
          ? `moved ${tierStatus.movement} ${tierStatus.previousTier}->${tierStatus.nextTier}`
          : `stayed ${tierStatus.nextTier}`;
        console.warn(`${tag} ⚠️  No items found.`);
        console.log(`${tag} 🧭 ${movementNote} [${tierStatus.phase} -> ${tierStatus.nextPhase}] — ${tierStatus.reason}`);
        continue;
      }

      const isEnglish = !feed.language || feed.language.toUpperCase() === "EN";
      const MAX_ITEMS = isEnglish
        ? 20
        : ({ 4: 15, 3: 10, 2: 5, 1: 2 }[feed.popularity_tier] ?? 5);

      const candidates = rawItems.slice(0, MAX_ITEMS * 3);

      // ── Dedup layer 1: URL fingerprint (SHA256 of title+link) ─────────────
      // Catches exact re-fetches of the same article on subsequent runs.
      const fingerprints = candidates.map(it =>
        fingerprintRaw(it.title, it.link || it.guid)
      );

      // ── Dedup layer 2: title-normalised per source ─────────────────────────
      // Catches same article re-published at a different URL (UTM params,
      // canonical vs AMP, re-post at new permalink, etc.).
      // Normalize: lowercase + collapse whitespace so minor casing/spacing
      // differences don't sneak through.
      const normTitle = t => (t || "").toLowerCase().replace(/\s+/g, " ").trim();
      const candidateNormTitles = candidates
        .map(it => normTitle(it.title))
        .filter(Boolean);

      const [existingRes, existingTitleRes] = await Promise.all([
        pool.query(
          `SELECT url FROM news_articles WHERE url = ANY($1)`,
          [fingerprints]
        ),
        candidateNormTitles.length
          ? pool.query(
              `SELECT LOWER(title) AS title
               FROM news_articles
               WHERE source_id = $1
                 AND LOWER(title) = ANY($2)`,
              [feed.id, candidateNormTitles]
            )
          : Promise.resolve({ rows: [] })
      ]);

      const existingSet    = new Set(existingRes.rows.map(r => r.url));
      const existingTitles = new Set(existingTitleRes.rows.map(r => r.title));
      // ── Dedup layer 3: within-batch ───────────────────────────────────────
      // If an RSS feed lists the same article twice (common), only the first
      // passes — avoids a wasted INSERT that ON CONFLICT would silently drop.
      const seenThisBatch  = new Set();

      const newItems = [];
      for (const item of candidates) {
        const fp = fingerprintRaw(item.title, item.link || item.guid);
        const nt = normTitle(item.title);
        if (existingSet.has(fp))    continue;  // same URL fingerprint already in DB
        if (existingTitles.has(nt)) continue;  // same title from this source in DB
        if (seenThisBatch.has(nt))  continue;  // duplicate title within this batch
        seenThisBatch.add(nt);
        newItems.push({ ...item, fingerprint: fp });
        if (newItems.length >= MAX_ITEMS) break;
      }

      let inserted = 0;
      const skipReasons = {};   // { reason: count } — aggregated at end of feed

      for (const item of newItems) {
        // ── Constraint validation pass ─────────────────────────────────────
        // Check every field that carries a NOT NULL / unique constraint before
        // touching the DB. Skip invalid items individually so a feed that mixes
        // valid articles with navigation/index pages still yields what it can.
        const title = item.title?.trim() || null;
        if (!title) {
          skipReasons['no title'] = (skipReasons['no title'] || 0) + 1;
          continue;
        }
        if (!item.fingerprint) {
          skipReasons['no url/guid'] = (skipReasons['no url/guid'] || 0) + 1;
          continue;
        }
        // Reject items whose "title" is just a URL, a single word, or a pure
        // number — these are typically sitemap index entries, not articles.
        if (/^https?:\/\//i.test(title) || title.split(/\s+/).length < 2) {
          skipReasons['non-article title'] = (skipReasons['non-article title'] || 0) + 1;
          continue;
        }
        // ──────────────────────────────────────────────────────────────────

        const summary = item.summary ? truncateAtWord(item.summary, 500) : null;

        let translatedTitle   = null;
        let translatedSummary = null;

        if (!isEnglish && TRANSLATION_ENABLED) {
          try {
            translatedTitle   = await translateWithTimeout(title, "EN-US");
            translatedSummary = await translateWithTimeout(summary, "EN-US");
          } catch (translateErr) {
            console.warn(`${tag} ⚠️ Translation failed, storing null`);
          }
        }

        const insertResult = await pool.query(
          `INSERT INTO news_articles (
             source_id, city_id, country_id,
             title, translated_title,
             url, article_url,
             summary, translated_summary,
             content, published_at, ingested_at,
             image_url, language
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             COALESCE($11, NOW()), NOW(),$12,$13
           )
           ON CONFLICT (url) DO NOTHING
           RETURNING id`,
          [
            feed.id,
            feed.city_id,
            feed.country_id,
            title,
            translatedTitle,
            item.fingerprint,
            item.link || null,
            summary,
            translatedSummary,
            null,
            item.publishedAt,
            item.imageUrl,
            feed.language || null
          ]
        );

        if (insertResult.rowCount > 0) {
          inserted++;
          const newArticleId = insertResult.rows[0].id;

          // Notify the article listener so it can classify, route, and assign an image.
          // This fires even if the DB trigger is unavailable.
          pool.query("SELECT pg_notify('new_article', $1::text)", [String(newArticleId)])
            .catch(err => console.warn(`  ⚠️  NOTIFY failed [${newArticleId}]: ${err.message}`));

          const lang = feed.language || "en";
          setImmediate(async () => {
            try {
              if (CJK_EXTRACT_LANGS.has(lang) && aiClient) {
                // CJK and no-space scripts: regex tokeniser produces character
                // n-grams which are meaningless. Use Claude Haiku to extract
                // real English keywords directly — no normalization step needed.
                await extractKeywordsWithClaude(
                  title, summary, newArticleId, item.publishedAt, feed.country_id || null
                );
                console.log(`  ✅ Keywords [${newArticleId}] Claude extracted (${lang})`);
              } else if (stopwordCache) {
                // All other languages: fast regex extractor (English, Arabic,
                // Russian, Spanish, etc.) — non-Latin tokens get normalized
                // later by storyThreadBuilder via Claude Haiku batch.
                const keywords = extractKeywords({ title, summary }, lang, stopwordCache);
                if (keywords.length > 0) {
                  await saveKeywords(
                    newArticleId, keywords, lang, item.publishedAt,
                    feed.country_id || null,
                    feed.country_id || null
                  );
                  console.log(`  ✅ Keywords [${newArticleId}] ${keywords.length} extracted (${lang}) — top: ${keywords.slice(0, 3).map(k => k.keyword).join(", ")}`);
                } else {
                  console.log(`  ⚠️  Keywords [${newArticleId}] 0 extracted (${lang})`);
                }
              }
            } catch (kwErr) {
              console.warn(`  ❌ Keywords [${newArticleId}] extraction failed: ${kwErr.message}`);
            }
          });
        }
      }

      const skipSummary = Object.entries(skipReasons)
        .map(([reason, n]) => `${n} ${reason}`)
        .join(', ');
      const skipNote = skipSummary ? `  skipped: ${skipSummary}` : '';
      const tierStatus = await applyBootstrapOutcome(feed, inserted);
      const movementNote = tierStatus.movement
        ? `moved ${tierStatus.movement} ${tierStatus.previousTier}->${tierStatus.nextTier}`
        : `stayed ${tierStatus.nextTier}`;

      console.log(
        `${tag} ✅ Inserted: ${inserted}/${newItems.length} new ` +
        `(pop tier ${feed.popularity_tier ?? "?"}, fetch tier ${feed.fetch_tier}->${tierStatus.nextTier}, max ${MAX_ITEMS})${skipNote}`
      );
      console.log(
        `${tag} 🧭 ${movementNote} [${tierStatus.phase} -> ${tierStatus.nextPhase}] — ${tierStatus.reason}`
      );

    } catch (err) {
      console.error(`${tag} ❌ Failed: ${err.message}`);
      await logFeedError(feed, err);
    }
  }

  console.log("🏁 Fetch batch complete.");
}

module.exports = fetchFeeds;
