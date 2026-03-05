require("dotenv").config();
const Parser = require("rss-parser");
const pool = require("./db");
const crypto = require("crypto");

const parserOptions = {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; RSSFetcher/1.0)",
    "Accept": "application/rss+xml, application/xml, text/xml, */*"
  },
  defaultRSS: 2.0,
  xml2js: {
    strict: false,
    normalize: true,
    normalizeTags: true  // this lowercases pubDate → pubdate
  }
};

function cleanText(text) {
  return text?.replace(/<[^>]*>/g, "").trim();
}

function buildFingerprint(item) {
  const base =
    (item.guid || "") +
    (item.link || "") +
    (item.isoDate || "") +
    cleanText(item.title || "") +
    cleanText(item.contentSnippet || item.description || "");

  return crypto.createHash("sha256").update(base).digest("hex");
}

function parseItemDate(item) {
  const raw = item.isoDate || item.pubdate || item["dc:date"] || item.dcdate || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100) return d;
  return null;
}

async function fetchXmlWithLimit(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: parserOptions.headers
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("Feed too large");
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function backfillDates() {
  console.log("🗓 Starting date backfill...", new Date().toISOString());

  // Get all active sources
  const { rows: sources } = await pool.query(`
    SELECT ns.id, ns.rss_url
    FROM news_sources ns
    WHERE ns.is_active = true
    AND ns.rss_url IS NOT NULL
    ORDER BY ns.id ASC
  `);

  console.log(`📋 Sources to process: ${sources.length}`);

  const parser = new Parser(parserOptions);
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const tag = `[${i + 1}/${sources.length}]`;

    try {
      const xml = await fetchXmlWithLimit(source.rss_url, 15000);
      const parsed = await parser.parseString(xml);

      if (!parsed?.items?.length) continue;

      let updatedThisSource = 0;

      for (const item of parsed.items) {
        const fingerprint = buildFingerprint(item);
        const publishedAt = parseItemDate(item);

        if (!publishedAt) {
          totalSkipped++;
          continue;
        }

        // Only update if published_at is currently null
        const result = await pool.query(
          `UPDATE news_articles
           SET published_at = $1
           WHERE url = $2
             AND (
               published_at IS NULL
               OR EXTRACT(YEAR FROM published_at) < 2000
               OR EXTRACT(YEAR FROM published_at) > 2100
             )`,
          [publishedAt, fingerprint]
        );

        if (result.rowCount > 0) {
          updatedThisSource++;
          totalUpdated++;
        }
      }

      if (updatedThisSource > 0) {
        console.log(`${tag} ✅ ${source.rss_url} → updated ${updatedThisSource}`);
      }

    } catch (err) {
      console.error(`${tag} ❌ Failed: ${source.rss_url} — ${err.message}`);
      totalFailed++;
    }
  }

  console.log(`\n🏁 Done.`);
  console.log(`   Updated: ${totalUpdated}`);
  console.log(`   Skipped (no date in feed): ${totalSkipped}`);
  console.log(`   Sources failed: ${totalFailed}`);

  await pool.end();
}

backfillDates().catch(console.error);
