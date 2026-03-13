require("dotenv").config();
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const pool = require("./db");
const { translateText } = require("./translator");
const crypto = require("crypto");
const { loadStopwords, extractKeywords, saveKeywords } = require("./keywordExtractor");

const TRANSLATION_ENABLED = false;

/* =========================================
   Parser Options
========================================= */
const parserOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
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

function truncateAtWord(text, limit = 250) {
  if (!text || text.length <= limit) return text;
  const truncated = text.substring(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace === -1) return truncated + "...";
  return truncated.substring(0, lastSpace) + "...";
}

function resolvePath(obj, dotPath) {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

async function logFeedError(feed, err, type = "RSS_FETCH_ERROR") {
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

    await pool.query(
      `UPDATE news_sources 
       SET last_error = $1, last_failed_at = NOW(),
           failure_count = failure_count + 1,
           is_active = CASE WHEN failure_count + 1 >= 5 THEN false ELSE is_active END
       WHERE id = $2`,
      [err.message?.substring(0, 1000), feed.id]
    );
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

  const d1 = new Date(cleaned);
  if (!isNaN(d1.getTime()) && d1.getFullYear() >= 2000 && d1.getFullYear() <= 2100) return d1;

  const stripped = cleaned.replace(/^[A-Za-z]{3},\s*/, "");
  const d2 = new Date(stripped);
  if (!isNaN(d2.getTime()) && d2.getFullYear() >= 2000 && d2.getFullYear() <= 2100) return d2;

  const normalised = cleaned.replace(/\bGMT\b/, "+0000").replace(/\bUTC\b/, "+0000");
  const d3 = new Date(normalised);
  if (!isNaN(d3.getTime()) && d3.getFullYear() >= 2000 && d3.getFullYear() <= 2100) return d3;

  const match = cleaned.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\s+\w{3,}\s+\d{4})/);
  if (match) {
    const d4 = new Date(match[0]);
    if (!isNaN(d4.getTime()) && d4.getFullYear() >= 2000 && d4.getFullYear() <= 2100) return d4;
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

async function fetchWithLimit(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await Promise.race([
    fetch(url, { signal: controller.signal, headers: parserOptions.headers }),
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

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await Promise.race([
    fetch(url, { signal: controller.signal, headers: parserOptions.headers }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Hard timeout after ${timeoutMs}ms`)), timeoutMs + 1000)
    )
  ]);

  clearTimeout(timeout);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
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
  const xml = await fetchWithLimit(feed.rss_url, 15000);
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
async function fetchSitemap(feed) {
  const xml = await fetchWithLimit(feed.rss_url || feed.scrape_url, 15000);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $("url, item").each((_, el) => {
    const $el = $(el);
    const link  = $el.find("loc").first().text().trim();
    const title =
      $el.find("news\\:title, title").first().text().trim() ||
      $el.find("news\\:name").first().text().trim();
    const dateRaw =
      $el.find("news\\:publication_date, lastmod, pubDate").first().text().trim();

    if (!link) return;
    items.push({
      title:       title || null,
      summary:     null,
      link,
      publishedAt: parseRobustDate(dateRaw),
      imageUrl:    $el.find("image\\:loc").first().text().trim() || null,
      guid:        link
    });
  });

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
  const html = await fetchWithLimit(feed.scrape_url, 20000);
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
  const html = await fetchWithLimit(feed.scrape_url, 20000);
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
  const mobileHeaders = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
  };

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20000);
  const response = await fetch(feed.scrape_url, {
    signal: controller.signal,
    headers: mobileHeaders
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

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
  const data = await fetchJson(feed.scrape_url || feed.rss_url);
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
  const html = await fetchWithLimit(feed.scrape_url, 20000);
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
async function fetchFeeds() {
  console.log("🚀 Starting fetch run...", new Date().toISOString());
  const startTime = Date.now();

  let stopwordCache = null;
  try {
    stopwordCache = await loadStopwords();
  } catch (swErr) {
    console.warn("⚠️  Could not load stopwords — keyword extraction disabled:", swErr.message);
  }

  const feedResult = await pool.query(`
    SELECT ns.id, ns.country_id, ns.rss_url, ns.scrape_url, ns.scrape_config,
           ns.city_id, ns.failure_count, ns.language_id, ns.popularity_tier,
           ns.source_type,
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

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const sourceType = feed.source_type || "rss";
    const emoji      = SOURCE_TYPE_EMOJI[sourceType] || "❓";
    const url        = feed.rss_url || feed.scrape_url || "(no url)";
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

      console.log(`\n${tag} ${emoji} ${sourceType} — ${url}`);

      let rawItems = [];
      try {
        rawItems = await dispatchFetch(feed);
      } catch (fetchErr) {
        console.error(`${tag} ❌ Fetch/parse failed: ${fetchErr.message}`);
        await logFeedError(feed, fetchErr);
        continue;
      }

      if (!rawItems.length) {
        console.warn(`${tag} ⚠️  No items found.`);
        continue;
      }

      const isEnglish = !feed.language || feed.language.toUpperCase() === "EN";
      const MAX_ITEMS = isEnglish
        ? 20
        : ({ 4: 15, 3: 10, 2: 5, 1: 2 }[feed.popularity_tier] ?? 5);

      const candidates = rawItems.slice(0, MAX_ITEMS * 3);

      // Dedup against DB — use guid/link as the fingerprint key
      const fingerprints = candidates.map(it =>
        fingerprintRaw(it.title, it.link || it.guid)
      );

      const existingRes = await pool.query(
        `SELECT url FROM news_articles WHERE url = ANY($1)`,
        [fingerprints]
      );
      const existingSet = new Set(existingRes.rows.map(r => r.url));

      const newItems = [];
      for (const item of candidates) {
        const fp = fingerprintRaw(item.title, item.link || item.guid);
        if (!existingSet.has(fp)) newItems.push({ ...item, fingerprint: fp });
        if (newItems.length >= MAX_ITEMS) break;
      }

      let inserted = 0;

      for (const item of newItems) {
        const title   = item.title;
        const summary = item.summary ? truncateAtWord(item.summary, 100) : null;

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

          if (stopwordCache) {
            const newArticleId = insertResult.rows[0].id;
            const lang         = feed.language || "en";
            setImmediate(async () => {
              try {
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
              } catch (kwErr) {
                console.warn(`  ❌ Keywords [${newArticleId}] extraction failed: ${kwErr.message}`);
              }
            });
          }
        }
      }

      console.log(`${tag} ✅ Inserted: ${inserted} (tier ${feed.popularity_tier ?? "?"}, max ${MAX_ITEMS})`);

    } catch (err) {
      console.error(`${tag} ❌ Failed: ${err.message}`);
      await logFeedError(feed, err);
    }
  }

  console.log("🏁 Fetch batch complete.");
}

module.exports = fetchFeeds;