require("dotenv").config();
const cheerio = require("cheerio");
const pool = require("./db");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const PROGRESS_FILE = path.join(__dirname, "sourceTester.progress.json");
const LOG_FILE      = path.join(__dirname, "sourceTester.log");

/* =========================================
   User Prompt Helper
========================================= */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

/* =========================================
   Progress Persistence
========================================= */
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      console.log(`\n📂 Found existing progress: last processed source ID ${data.lastId} (${data.applied} applied, ${data.skipped} skipped, ${data.failed} failed)`);
      return data;
    }
  } catch {}
  return { lastId: 0, applied: 0, skipped: 0, failed: 0 };
}

function saveProgress(state) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
}

function clearProgress() {
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

/* =========================================
   Logger
========================================= */
function logResult(source, detection, action) {
  const line = JSON.stringify({
    ts:         new Date().toISOString(),
    id:         source.id,
    name:       source.name,
    site_url:   source.site_url,
    detected:   detection?.type || null,
    confidence: detection?.confidence || null,
    action
  });
  fs.appendFileSync(LOG_FILE, line + "\n");
}

/* =========================================
   ETA Tracker
========================================= */
class ETATracker {
  constructor() {
    this.times = [];
    this.start = Date.now();
  }
  record(ms) {
    this.times.push(ms);
    if (this.times.length > 20) this.times.shift(); // rolling window
  }
  avg() {
    if (!this.times.length) return null;
    return this.times.reduce((a, b) => a + b, 0) / this.times.length;
  }
  eta(remaining) {
    const avg = this.avg();
    if (!avg) return "calculating...";
    const ms = avg * remaining;
    if (ms < 60000)  return `~${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `~${Math.round(ms / 60000)}m`;
    return `~${(ms / 3600000).toFixed(1)}h`;
  }
  elapsed() {
    const ms = Date.now() - this.start;
    if (ms < 60000)   return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }
}

/* =========================================
   HTTP Fetch with UA + Timeout
========================================= */
const USER_AGENTS = {
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  googlebot:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
};

async function fetchUrl(url, { ua = "desktop", timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENTS[ua],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      },
      redirect: "follow"
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    return { text, contentType, finalUrl: response.url };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Try multiple UAs in sequence, return first success
async function fetchWithFallback(url) {
  const attempts = ["desktop", "mobile", "googlebot"];
  let lastErr;
  for (const ua of attempts) {
    try {
      const result = await fetchUrl(url, { ua });
      return { ...result, ua };
    } catch (err) {
      lastErr = err;
      console.log(`    ↳ ${ua} UA failed: ${err.message}`);
    }
  }
  throw lastErr;
}

/* =========================================
   Common RSS/feed URL patterns to probe
========================================= */
const FEED_PATHS = [
  "/feed", "/feed/", "/rss", "/rss/", "/rss.xml", "/atom.xml",
  "/feeds/posts/default", "/feed.xml", "/index.xml",
  "/news/rss", "/news/feed", "/en/rss", "/en/feed",
  "/?feed=rss2", "/?feed=rss", "/?format=feed&type=rss"
];

const SITEMAP_PATHS = [
  "/sitemap.xml", "/sitemap_news.xml", "/news-sitemap.xml",
  "/sitemap/news.xml", "/sitemap/google-news.xml"
];

/* =========================================
   Content Detectors
========================================= */
function looksLikeRSS(text) {
  return /<(rss|feed|rdf:rdf)/i.test(text.substring(0, 1000));
}

function looksLikeAtom(text) {
  return /<feed[^>]+xmlns/i.test(text.substring(0, 1000));
}

function looksLikeSitemap(text) {
  return /<urlset|<sitemapindex/i.test(text.substring(0, 1000));
}

function looksLikeNewsSitemap(text) {
  return looksLikeSitemap(text) && /news:/i.test(text.substring(0, 3000));
}

function looksLikeJSON(text) {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/* =========================================
   Probe for hidden RSS/sitemap feeds
========================================= */
async function probeFeeds(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");

  // Check <link rel="alternate"> in homepage HTML first
  try {
    const { text } = await fetchUrl(base);
    const $ = cheerio.load(text);
    const autodiscovered = [];
    $('link[rel="alternate"]').each((_, el) => {
      const type = $(el).attr("type") || "";
      const href = $(el).attr("href") || "";
      if (!href) return;
      if (type.includes("rss") || type.includes("atom")) {
        autodiscovered.push({
          url: href.startsWith("http") ? href : base + href,
          type: type.includes("atom") ? "atom" : "rss"
        });
      }
    });
    if (autodiscovered.length) return autodiscovered[0];
  } catch {}

  // Probe common feed paths
  for (const path of FEED_PATHS) {
    const url = base + path;
    try {
      const { text } = await fetchUrl(url, { timeoutMs: 8000 });
      if (looksLikeAtom(text)) return { url, type: "atom" };
      if (looksLikeRSS(text))  return { url, type: "rss" };
    } catch {}
  }

  // Probe sitemap paths
  for (const path of SITEMAP_PATHS) {
    const url = base + path;
    try {
      const { text } = await fetchUrl(url, { timeoutMs: 8000 });
      if (looksLikeNewsSitemap(text)) return { url, type: "news_sitemap" };
      if (looksLikeSitemap(text))     return { url, type: "xml_sitemap" };
    } catch {}
  }

  return null;
}

/* =========================================
   HTML Article Candidate Scoring
   Scores a CSS selector by how many elements
   it finds that look like article list items
   (have a link + text of reasonable length)
========================================= */
const CANDIDATE_LIST_SELECTORS = [
  "article", ".article", ".news-item", ".news-article",
  ".post", ".story", ".item", ".entry",
  "li.article", "li.news", "li.post", "li.story",
  ".card", ".news-card", ".article-card",
  "[class*='article']", "[class*='news-item']", "[class*='post-item']"
];

const CANDIDATE_TITLE_SELECTORS = [
  "h1 a", "h2 a", "h3 a", "h4 a",
  ".title a", ".headline a", ".article-title a",
  "a.title", "a.headline",
  "h1", "h2", "h3", "h4",
  ".title", ".headline"
];

function scoreListSelector($, listSel) {
  const items = $(listSel);
  if (items.length < 3) return { score: 0, count: 0 };

  let withLink  = 0;
  let withText  = 0;
  let withDate  = 0;
  let totalText = 0;

  items.each((_, el) => {
    const $el  = $(el);
    const link = $el.find("a").first().attr("href");
    const text = $el.text().trim();
    const hasDate = $el.find("time, .date, .published, [class*='date'], [class*='time']").length > 0;

    if (link) withLink++;
    if (text.length > 10) { withText++; totalText += text.length; }
    if (hasDate) withDate++;
  });

  const avg  = totalText / Math.max(items.length, 1);
  const score =
    (withLink  / items.length) * 40 +
    (withText  / items.length) * 30 +
    (withDate  / items.length) * 20 +
    Math.min(items.length / 10, 1) * 10;

  return { score: Math.round(score), count: items.length, withLink, withDate, avgTextLen: Math.round(avg) };
}

function scoreTitleSelector($, listSel, titleSel) {
  const items = $(listSel);
  let found = 0;
  let totalLen = 0;

  items.each((_, el) => {
    const text = $(el).find(titleSel).first().text().trim();
    if (text.length > 5) { found++; totalLen += text.length; }
  });

  return {
    score: Math.round((found / Math.max(items.length, 1)) * 100),
    avgLen: Math.round(totalLen / Math.max(found, 1))
  };
}

function findBestSelectors($) {
  let bestList  = null;
  let bestScore = 0;

  for (const sel of CANDIDATE_LIST_SELECTORS) {
    const { score, count } = scoreListSelector($, sel);
    if (score > bestScore && count >= 3) {
      bestScore = score;
      bestList  = sel;
    }
  }

  if (!bestList) return null;

  let bestTitle     = null;
  let bestTitleScore = 0;

  for (const sel of CANDIDATE_TITLE_SELECTORS) {
    const { score, avgLen } = scoreTitleSelector($, bestList, sel);
    if (score > bestTitleScore && avgLen > 10) {
      bestTitleScore = score;
      bestTitle      = sel;
    }
  }

  // Find link selector (often same as title)
  let linkSel = bestTitle || "a";
  if (!bestTitle?.includes("a")) {
    const withA = bestTitle + " a";
    const { score } = scoreTitleSelector($, bestList, withA);
    if (score > 50) linkSel = withA;
  }

  // Find date selector
  const dateCandidates = ["time", ".date", ".published", "[class*='date']", "[class*='time']", "span.time"];
  let dateSel  = null;
  let dateAttr = null;
  for (const sel of dateCandidates) {
    const { score } = scoreTitleSelector($, bestList, sel);
    if (score > 40) {
      dateSel = sel;
      // Check if date is in an attribute
      const sample = $(bestList).first().find(sel).first();
      if (sample.attr("datetime")) dateAttr = "datetime";
      break;
    }
  }

  // Find summary selector
  const summaryCandidates = ["p", ".summary", ".excerpt", ".description", "[class*='summary']", "[class*='excerpt']"];
  let summarySel = null;
  for (const sel of summaryCandidates) {
    const { score, avgLen } = scoreTitleSelector($, bestList, sel);
    if (score > 40 && avgLen > 20) { summarySel = sel; break; }
  }

  // Find image selector
  const imageCandidates = ["img", ".thumbnail img", ".image img", "[class*='thumb'] img"];
  let imageSel = null;
  for (const sel of imageCandidates) {
    const { score } = scoreTitleSelector($, bestList, sel);
    if (score > 30) { imageSel = sel; break; }
  }

  return {
    listScore:  bestScore,
    listCount:  scoreListSelector($, bestList).count,
    titleScore: bestTitleScore,
    config: {
      list_selector:    bestList,
      title_selector:   bestTitle,
      link_selector:    linkSel,
      ...(summarySel && { summary_selector: summarySel }),
      ...(dateSel    && { date_selector:    dateSel }),
      ...(dateAttr   && { date_attr:        dateAttr }),
      ...(imageSel   && { image_selector:   imageSel })
    }
  };
}

/* =========================================
   Sample Extraction — show real titles
========================================= */
function extractSamples($, config, baseUrl, n = 5) {
  const samples = [];
  $(config.list_selector).slice(0, n * 3).each((_, el) => {
    if (samples.length >= n) return false;
    const $el     = $(el);
    const titleEl = config.title_selector ? $el.find(config.title_selector).first() : $el.find("h2,h3").first();
    const linkEl  = config.link_selector  ? $el.find(config.link_selector).first()  : titleEl;
    const rawLink = linkEl.attr("href") || "";
    const link    = rawLink.startsWith("http") ? rawLink : (baseUrl + rawLink);
    const title   = titleEl.text().replace(/\s+/g, " ").trim();
    if (title.length > 5) samples.push({ title, link });
  });
  return samples;
}

/* =========================================
   Telegram detection
========================================= */
function looksLikeTelegram(url) {
  return /t\.me\/s\//i.test(url);
}

/* =========================================
   Main Detection Pipeline
========================================= */
async function detectSource(source) {
  const siteUrl = source.site_url?.replace(/\/$/, "");
  if (!siteUrl) return { type: null, reason: "no site_url" };

  console.log(`\n${"─".repeat(60)}`);
  console.log(`🔎 [${source.id}] ${source.name}`);
  console.log(`   site_url: ${siteUrl}`);
  console.log(`   country:  ${source.country_name || "?"} | lang: ${source.language || "?"}`);

  // ── Telegram shortcut
  if (looksLikeTelegram(siteUrl)) {
    return {
      type:       "telegram_channel",
      scrape_url: siteUrl,
      config:     null,
      confidence: 95,
      samples:    []
    };
  }

  // ── Probe for RSS/Atom/Sitemap first (fastest, most reliable)
  console.log("  🔭 Probing for RSS/Atom/Sitemap...");
  const feedProbe = await probeFeeds(siteUrl);
  if (feedProbe) {
    console.log(`  ✅ Found ${feedProbe.type} feed: ${feedProbe.url}`);
    return {
      type:       feedProbe.type,
      scrape_url: feedProbe.url,
      rss_url:    feedProbe.url,
      config:     null,
      confidence: 98,
      samples:    []
    };
  }

  // ── Fetch the site itself
  console.log("  🌐 Fetching site HTML...");
  let fetchResult;
  try {
    fetchResult = await fetchWithFallback(siteUrl);
  } catch (err) {
    return { type: null, reason: `Unreachable: ${err.message}` };
  }

  const { text, contentType, ua } = fetchResult;

  // ── JSON API
  if (looksLikeJSON(text)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : (parsed.articles || parsed.data || parsed.items || parsed.results);
      if (Array.isArray(items) && items.length > 0) {
        const sample = items[0];
        const titleField   = ["title","headline","name"].find(k => sample[k]);
        const linkField    = ["url","link","href"].find(k => sample[k]);
        const summaryField = ["summary","excerpt","description","body"].find(k => sample[k]);
        const dateField    = ["publishedAt","published_at","date","pubDate","created_at"].find(k => sample[k]);
        const imageField   = ["image","thumbnail","imageUrl","image_url","photo"].find(k => sample[k]);

        return {
          type:       "json_api",
          scrape_url: siteUrl,
          config: {
            items_path:    Array.isArray(parsed) ? null : Object.keys(parsed).find(k => Array.isArray(parsed[k])),
            title_field:   titleField   || "title",
            link_field:    linkField    || "url",
            ...(summaryField && { summary_field: summaryField }),
            ...(dateField    && { date_field:    dateField }),
            ...(imageField   && { image_field:   imageField })
          },
          confidence: 90,
          samples:    items.slice(0, 3).map(i => ({ title: i[titleField] || "?", link: i[linkField] || "" }))
        };
      }
    }
  }

  // ── HTML analysis
  const $ = cheerio.load(text);
  const pageTitle = $("title").text().trim();
  console.log(`  📄 Page title: "${pageTitle}"`);

  // Check if page appears JS-rendered (very little text content)
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (bodyText.length < 500) {
    console.log("  ⚠️  Very little text — may require headless rendering");
    return {
      type:       "headless_html",
      scrape_url: siteUrl,
      config:     null,
      confidence: 60,
      samples:    [],
      warning:    "Page appears JS-rendered. Puppeteer required."
    };
  }

  // Score selectors
  console.log("  🧪 Scoring HTML selectors...");
  const best = findBestSelectors($);

  if (!best || best.listScore < 30) {
    // Try mobile UA as fallback
    if (ua !== "mobile") {
      console.log("  📱 Low score on desktop — trying mobile HTML...");
      try {
        const mob = await fetchUrl(siteUrl, { ua: "mobile" });
        const $m  = cheerio.load(mob.text);
        const mobBest = findBestSelectors($m);
        if (mobBest && mobBest.listScore > (best?.listScore || 0)) {
          const samples = extractSamples($m, mobBest.config, siteUrl);
          return {
            type:       "mobile_html",
            scrape_url: siteUrl,
            config:     { ...mobBest.config, base_url: siteUrl },
            confidence: Math.min(mobBest.listScore, 85),
            samples
          };
        }
      } catch {}
    }

    return { type: null, reason: `Could not find consistent article list (best score: ${best?.listScore ?? 0})` };
  }

  best.config.base_url = siteUrl;
  const samples = extractSamples($, best.config, siteUrl);

  return {
    type:       "html_list",
    scrape_url: siteUrl,
    config:     best.config,
    confidence: Math.min(best.listScore, 90),
    samples
  };
}

/* =========================================
   DB Delete
========================================= */
async function deleteSource(id) {
  try {
    await pool.query(`DELETE FROM news_sources WHERE id = $1`, [id]);
    console.log(`  🗑  Deleted source #${id} from DB`);
  } catch (err) {
    console.error(`  ❌ Failed to delete source #${id}: ${err.message}`);
  }
}

/* =========================================
   DB Write
========================================= */
async function applyToDb(source, detection) {
  await pool.query(
    `UPDATE news_sources SET
       source_type  = $1,
       scrape_url   = $2,
       scrape_config = $3,
       rss_url      = COALESCE($4, rss_url),
       is_active    = true,
       failure_count = 0,
       last_error   = NULL,
       last_failed_at = NULL
     WHERE id = $5`,
    [
      detection.type,
      detection.scrape_url,
      detection.config ? JSON.stringify(detection.config) : null,
      detection.rss_url || null,
      source.id
    ]
  );
  console.log(`  💾 DB updated — source #${source.id} reactivated as ${detection.type}`);
}

/* =========================================
   Progress Summary Bar
========================================= */
function printProgress({ i, total, applied, skipped, failed, eta }) {
  const remaining = total - i - 1;
  const pct = Math.round(((i + 1) / total) * 100);
  const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
  console.log(`\n  ${bar} ${pct}% | ${i + 1}/${total} done | ✅ ${applied} applied | ⏭ ${skipped} skipped | ❌ ${failed} failed | ⏳ ETA ${eta} | ${remaining} remaining`);
}

/* =========================================
   Interactive Loop
========================================= */
async function runTester() {
  console.log("🚀 Source Tester — Interactive Mode");
  console.log("   Tests inactive sources via site_url and suggests fetch method.");
  console.log(`   Progress saved to: ${PROGRESS_FILE}`);
  console.log(`   Log saved to:      ${LOG_FILE}\n`);

  // Load or reset progress
  let progress = loadProgress();

  if (progress.lastId > 0) {
    const resume = await ask(`  Resume from source ID ${progress.lastId}? (y/n — n will restart from beginning): `);
    if (resume.trim().toLowerCase() === "n") {
      clearProgress();
      progress = { lastId: 0, applied: 0, skipped: 0, failed: 0 };
      console.log("  🔄 Restarting from beginning.\n");
    } else {
      console.log(`  ▶️  Resuming.\n`);
    }
  }

  const { rows: sources } = await pool.query(`
    SELECT ns.id, ns.name, ns.site_url, ns.rss_url, ns.language,
           c.name AS country_name
    FROM news_sources ns
    LEFT JOIN countries c ON c.id = ns.country_id
    WHERE ns.is_active = false
      AND ns.site_url IS NOT NULL
      AND ns.site_url != ''
      AND ns.id > $1
    ORDER BY ns.id ASC
  `, [progress.lastId]);

  const total = sources.length;
  console.log(`📋 ${total} inactive sources remaining to test.\n`);

  if (!total) {
    console.log("Nothing to test — all sources have been processed.");
    clearProgress();
    rl.close();
    return;
  }

  const CONFIDENCE_THRESHOLD = 95;

  let { applied, skipped, failed } = progress;
  const eta = new ETATracker();

  for (let i = 0; i < sources.length; i++) {
    const source    = sources[i];
    const stepStart = Date.now();
    const remaining = total - i - 1;

    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${i + 1}/${total}] elapsed: ${eta.elapsed()} | ETA: ${eta.eta(remaining)}`);

    let detection;
    try {
      detection = await Promise.race([
        detectSource(source),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Detection timed out after 2m")), 120000)
        )
      ]);
    } catch (err) {
      const isTimeout = err.message.includes("timed out");
      console.log(isTimeout ? "  ⏱  Timed out (2m) — deleting source" : `  ❌ Detection crashed: ${err.message} — deleting source`);
      failed++;
      logResult(source, null, isTimeout ? "timeout:deleted" : `crashed:deleted: ${err.message}`);
      await deleteSource(source.id);
      progress = { lastId: source.id, applied, skipped, failed };
      saveProgress(progress);
      eta.record(Date.now() - stepStart);
      printProgress({ i, total, applied, skipped, failed, eta: eta.eta(remaining - 1) });
      continue;
    }

    // ── No method found → delete
    if (!detection.type) {
      console.log(`  ❌ No method found — ${detection.reason} — deleting source`);
      failed++;
      logResult(source, null, `no_method:deleted: ${detection.reason}`);
      await deleteSource(source.id);
      progress = { lastId: source.id, applied, skipped, failed };
      saveProgress(progress);
      eta.record(Date.now() - stepStart);
      printProgress({ i, total, applied, skipped, failed, eta: eta.eta(remaining - 1) });
      continue;
    }

    // ── Print result
    console.log(`\n  ┌─ RESULT ──────────────────────────────`);
    console.log(`  │ type:       ${detection.type}`);
    console.log(`  │ confidence: ${detection.confidence}%`);
    console.log(`  │ scrape_url: ${detection.scrape_url}`);
    if (detection.warning) {
      console.log(`  │ ⚠️  ${detection.warning}`);
    }
    if (detection.config) {
      console.log(`  │ config:     ${JSON.stringify(detection.config, null, 0)}`);
    }
    if (detection.samples?.length) {
      console.log(`  │`);
      console.log(`  │ Sample titles extracted:`);
      detection.samples.forEach((s, idx) => {
        console.log(`  │   ${idx + 1}. "${s.title.substring(0, 80)}"`);
        if (s.link) console.log(`  │      ${s.link.substring(0, 80)}`);
      });
    }
    console.log(`  └───────────────────────────────────────`);

    // ── High confidence → auto-apply
    if (detection.confidence >= CONFIDENCE_THRESHOLD) {
      console.log(`  ✅ Confidence ${detection.confidence}% >= ${CONFIDENCE_THRESHOLD}% — auto-applying`);
      await applyToDb(source, detection);
      applied++;
      logResult(source, detection, `auto-applied:${detection.confidence}%`);

    // ── Low confidence → auto-skip, log for manual review
    } else {
      console.log(`  ⏭  Confidence ${detection.confidence}% < ${CONFIDENCE_THRESHOLD}% — skipped (review log)`);
      skipped++;
      logResult(source, detection, `low-confidence:${detection.confidence}%`);
    }

    eta.record(Date.now() - stepStart);
    progress = { lastId: source.id, applied, skipped, failed };
    saveProgress(progress);
    printProgress({ i, total, applied, skipped, failed, eta: eta.eta(remaining - 1) });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ Run complete.`);
  console.log(`   Auto-applied: ${applied} | Low-confidence skipped: ${skipped} | Failed/deleted: ${failed}`);
  console.log(`   Total elapsed: ${eta.elapsed()}`);
  console.log(`   Review low-confidence sources: ${LOG_FILE}`);
  console.log(`   Filter with: grep low-confidence ${LOG_FILE}`);

  if (applied + skipped + failed >= total) {
    clearProgress();
    console.log("   Progress file cleared — all sources processed.");
  }

  rl.close();
  process.exit(0);
}
runTester().catch(err => {
  console.error("💥 Fatal error:", err);
  rl.close();
  process.exit(1);
});