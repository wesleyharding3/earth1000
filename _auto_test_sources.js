#!/usr/bin/env node
'use strict';

/**
 * _auto_test_sources.js
 *
 * Non-interactive batch tester. Walks every is_active=false source
 * with a site_url, probes for RSS / Atom / sitemap / HTML scraping
 * config, and applies user-specified decision rules:
 *
 *   ADD (apply + reactivate) when:
 *     - detection.confidence >= 90, OR
 *     - >= 2 sample article titles look like real news (length 12-220
 *       chars, mostly unique, not "Sign in"/"Loading"/etc).
 *
 *   DELETE the source row when:
 *     - detectSource returns no method AND no samples, OR
 *     - the site is unreachable across desktop / mobile / Googlebot UAs.
 *
 *   LEAVE inactive (manual-review pile) when:
 *     - detection found a method but confidence < 90 AND samples don't
 *       pass the "looks like news" filter. The source isn't deleted —
 *       it stays in the inactive queue so the user can re-test or
 *       hand-fix selectors later. Logged with reason for triage.
 *
 * The detection pipeline is a lifted copy of the proven logic in
 * sourceTester.js, refactored into pure functions that don't depend
 * on stdin / readline / progress files. Decision-time apply/delete
 * SQL is identical to sourceTester's so the schema invariants stay
 * the same.
 *
 * Run:
 *   node _auto_test_sources.js                # process every inactive source
 *   node _auto_test_sources.js --ids=1,2,3    # only those IDs
 *   node _auto_test_sources.js --limit=50     # cap pass count
 *   node _auto_test_sources.js --dry          # detect + log but no DB write
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const ID_FILTER = ARGV.get('ids')
  ? String(ARGV.get('ids')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
  : null;
const LIMIT = parseInt(ARGV.get('limit') || '0', 10);
const DRY   = !!ARGV.get('dry');
// --never-fetched: only iterate inactive sources that have never had
// a successful article. Mirrors the user's brief: "find any sources
// that have never been fetched once and run those through
// sourcetester, if any of these are unfetchable, delete them."
const NEVER_FETCHED_ONLY = !!ARGV.get('never-fetched');

// User's decision rules. Threshold is intentionally lower than the
// interactive sourceTester's 95% — we layer the sample-quality test
// on top so genuine news outlets that score 70-89% still pass.
const CONFIDENCE_THRESHOLD = 90;
const SAMPLE_MIN_COUNT     = 2;
const SAMPLE_TITLE_MIN_LEN = 12;
const SAMPLE_TITLE_MAX_LEN = 220;

// ─── HTTP fetch (lifted from sourceTester.js) ──────────────────────────
const USER_AGENTS = {
  desktop:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  mobile:   'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  googlebot:'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};
async function fetchUrl(url, { ua = 'desktop', timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENTS[ua],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return { text, contentType: r.headers.get('content-type') || '', finalUrl: r.url };
  } catch (e) { clearTimeout(timeout); throw e; }
}
async function fetchWithFallback(url) {
  const attempts = ['desktop', 'mobile', 'googlebot'];
  let lastErr;
  for (const ua of attempts) {
    try { return { ...(await fetchUrl(url, { ua })), ua }; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ─── Feed probe (lifted) ──────────────────────────────────────────────
const FEED_PATHS = [
  '/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/atom.xml',
  '/feeds/posts/default', '/feed.xml', '/index.xml',
  '/news/rss', '/news/feed', '/en/rss', '/en/feed',
  '/?feed=rss2', '/?feed=rss', '/?format=feed&type=rss',
];
const SITEMAP_PATHS = [
  '/sitemap.xml', '/sitemap_news.xml', '/news-sitemap.xml',
  '/sitemap/news.xml', '/sitemap/google-news.xml',
];
const looksLikeRSS         = (t) => /<(rss|feed|rdf:rdf)/i.test(t.substring(0, 1000));
const looksLikeAtom        = (t) => /<feed[^>]+xmlns/i.test(t.substring(0, 1000));
const looksLikeSitemap     = (t) => /<urlset|<sitemapindex/i.test(t.substring(0, 1000));
const looksLikeNewsSitemap = (t) => looksLikeSitemap(t) && /news:/i.test(t.substring(0, 3000));
const looksLikeJSON        = (t) => { const s = t.trimStart(); return s.startsWith('{') || s.startsWith('['); };

async function probeFeeds(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  // <link rel=alternate> autodiscovery
  try {
    const { text } = await fetchUrl(base);
    const $ = cheerio.load(text);
    const found = [];
    $('link[rel="alternate"]').each((_, el) => {
      const type = $(el).attr('type') || '';
      const href = $(el).attr('href') || '';
      if (!href) return;
      if (type.includes('rss') || type.includes('atom')) {
        found.push({
          url: href.startsWith('http') ? href : base + href,
          type: type.includes('atom') ? 'atom' : 'rss',
        });
      }
    });
    if (found.length) return found[0];
  } catch (_) {}
  // Common feed paths
  for (const p of FEED_PATHS) {
    try {
      const { text } = await fetchUrl(base + p, { timeoutMs: 7000 });
      if (looksLikeAtom(text)) return { url: base + p, type: 'atom' };
      if (looksLikeRSS(text))  return { url: base + p, type: 'rss' };
    } catch (_) {}
  }
  // Sitemap fallback
  for (const p of SITEMAP_PATHS) {
    try {
      const { text } = await fetchUrl(base + p, { timeoutMs: 7000 });
      if (looksLikeNewsSitemap(text)) return { url: base + p, type: 'news_sitemap' };
      if (looksLikeSitemap(text))     return { url: base + p, type: 'xml_sitemap' };
    } catch (_) {}
  }
  return null;
}

// ─── HTML selector scoring (lifted) ──────────────────────────────────
const CANDIDATE_LIST_SELECTORS = [
  'article', '.article', '.news-item', '.news-article',
  '.post', '.story', '.item', '.entry',
  'li.article', 'li.news', 'li.post', 'li.story',
  '.card', '.news-card', '.article-card',
  "[class*='article']", "[class*='news-item']", "[class*='post-item']",
];
const CANDIDATE_TITLE_SELECTORS = [
  'h1 a', 'h2 a', 'h3 a', 'h4 a',
  '.title a', '.headline a', '.article-title a',
  'a.title', 'a.headline',
  'h1', 'h2', 'h3', 'h4',
  '.title', '.headline',
];
function scoreListSelector($, sel) {
  const items = $(sel);
  if (items.length < 3) return { score: 0, count: 0 };
  let withLink = 0, withText = 0, withDate = 0, totalText = 0;
  items.each((_, el) => {
    const $el = $(el);
    if ($el.find('a').first().attr('href')) withLink++;
    const text = $el.text().trim();
    if (text.length > 10) { withText++; totalText += text.length; }
    if ($el.find("time, .date, .published, [class*='date'], [class*='time']").length) withDate++;
  });
  const score = (withLink/items.length)*40 + (withText/items.length)*30
              + (withDate/items.length)*20 + Math.min(items.length/10, 1)*10;
  return { score: Math.round(score), count: items.length };
}
function scoreTitleSelector($, listSel, titleSel) {
  const items = $(listSel);
  let found = 0, totalLen = 0;
  items.each((_, el) => {
    const t = $(el).find(titleSel).first().text().trim();
    if (t.length > 5) { found++; totalLen += t.length; }
  });
  return { score: Math.round((found/Math.max(items.length, 1))*100), avgLen: Math.round(totalLen/Math.max(found, 1)) };
}
function findBestSelectors($) {
  let bestList = null, bestScore = 0;
  for (const sel of CANDIDATE_LIST_SELECTORS) {
    const s = scoreListSelector($, sel);
    if (s.score > bestScore && s.count >= 3) { bestScore = s.score; bestList = sel; }
  }
  if (!bestList) return null;
  let bestTitle = null, bestTitleScore = 0;
  for (const sel of CANDIDATE_TITLE_SELECTORS) {
    const { score, avgLen } = scoreTitleSelector($, bestList, sel);
    if (score > bestTitleScore && avgLen > 10) { bestTitleScore = score; bestTitle = sel; }
  }
  let linkSel = bestTitle || 'a';
  if (bestTitle && !bestTitle.includes('a')) {
    const withA = bestTitle + ' a';
    const { score } = scoreTitleSelector($, bestList, withA);
    if (score > 50) linkSel = withA;
  }
  const dateCands = ['time', '.date', '.published', "[class*='date']", "[class*='time']", 'span.time'];
  let dateSel = null, dateAttr = null;
  for (const sel of dateCands) {
    const { score } = scoreTitleSelector($, bestList, sel);
    if (score > 40) {
      dateSel = sel;
      const sample = $(bestList).first().find(sel).first();
      if (sample.attr('datetime')) dateAttr = 'datetime';
      break;
    }
  }
  const summaryCands = ['p', '.summary', '.excerpt', '.description', "[class*='summary']", "[class*='excerpt']"];
  let summarySel = null;
  for (const sel of summaryCands) {
    const { score, avgLen } = scoreTitleSelector($, bestList, sel);
    if (score > 40 && avgLen > 20) { summarySel = sel; break; }
  }
  const imgCands = ['img', '.thumbnail img', '.image img', "[class*='thumb'] img"];
  let imgSel = null;
  for (const sel of imgCands) {
    const { score } = scoreTitleSelector($, bestList, sel);
    if (score > 30) { imgSel = sel; break; }
  }
  return {
    listScore: bestScore,
    listCount: scoreListSelector($, bestList).count,
    titleScore: bestTitleScore,
    config: {
      list_selector:  bestList,
      title_selector: bestTitle,
      link_selector:  linkSel,
      ...(summarySel && { summary_selector: summarySel }),
      ...(dateSel    && { date_selector:    dateSel }),
      ...(dateAttr   && { date_attr:        dateAttr }),
      ...(imgSel     && { image_selector:   imgSel }),
    },
  };
}
function extractSamples($, config, baseUrl, n = 5) {
  const samples = [];
  $(config.list_selector).slice(0, n * 3).each((_, el) => {
    if (samples.length >= n) return false;
    const $el = $(el);
    const titleEl = config.title_selector ? $el.find(config.title_selector).first() : $el.find('h2,h3').first();
    const linkEl  = config.link_selector  ? $el.find(config.link_selector).first()  : titleEl;
    const raw = linkEl.attr('href') || '';
    const link = raw.startsWith('http') ? raw : (baseUrl + raw);
    const title = titleEl.text().replace(/\s+/g, ' ').trim();
    if (title.length > 5) samples.push({ title, link });
  });
  return samples;
}

// ─── Detection pipeline (lifted, simplified) ───────────────────────────
async function detectSource(source) {
  const siteUrl = source.site_url?.replace(/\/$/, '');
  if (!siteUrl) return { type: null, reason: 'no site_url' };
  if (/t\.me\/s\//i.test(siteUrl)) {
    return { type: 'telegram_channel', scrape_url: siteUrl, config: null, confidence: 95, samples: [] };
  }
  // RSS / Atom / Sitemap probe
  const feed = await probeFeeds(siteUrl);
  if (feed) {
    return { type: feed.type, scrape_url: feed.url, rss_url: feed.url, config: null, confidence: 98, samples: [] };
  }
  // Site fetch
  let result;
  try { result = await fetchWithFallback(siteUrl); }
  catch (e) { return { type: null, reason: `Unreachable: ${e.message}` }; }
  const { text, ua } = result;
  // JSON API
  if (looksLikeJSON(text)) {
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : (parsed.articles || parsed.data || parsed.items || parsed.results);
      if (Array.isArray(items) && items.length) {
        const s = items[0];
        const tField = ['title','headline','name'].find(k => s[k]);
        const lField = ['url','link','href'].find(k => s[k]);
        return {
          type: 'json_api', scrape_url: siteUrl,
          config: { items_path: Array.isArray(parsed) ? null : Object.keys(parsed).find(k => Array.isArray(parsed[k])), title_field: tField || 'title', link_field: lField || 'url' },
          confidence: 90,
          samples: items.slice(0, 3).map(i => ({ title: i[tField] || '?', link: i[lField] || '' })),
        };
      }
    } catch (_) {}
  }
  const $ = cheerio.load(text);
  if ($('body').text().replace(/\s+/g, ' ').trim().length < 500) {
    return { type: 'headless_html', scrape_url: siteUrl, config: null, confidence: 60, samples: [], warning: 'JS-rendered; needs Puppeteer' };
  }
  const best = findBestSelectors($);
  if (!best || best.listScore < 30) {
    if (ua !== 'mobile') {
      try {
        const mob = await fetchUrl(siteUrl, { ua: 'mobile' });
        const $m  = cheerio.load(mob.text);
        const mb  = findBestSelectors($m);
        if (mb && mb.listScore > (best?.listScore || 0)) {
          const samples = extractSamples($m, mb.config, siteUrl);
          return { type: 'mobile_html', scrape_url: siteUrl, config: { ...mb.config, base_url: siteUrl }, confidence: Math.min(mb.listScore, 85), samples };
        }
      } catch (_) {}
    }
    return { type: null, reason: `No consistent article list (best score: ${best?.listScore ?? 0})` };
  }
  best.config.base_url = siteUrl;
  return { type: 'html_list', scrape_url: siteUrl, config: best.config, confidence: Math.min(best.listScore, 90), samples: extractSamples($, best.config, siteUrl) };
}

// ─── Sample-quality test (the user's "doesn't look like junk" rule) ───
const JUNK_TITLE_PATTERNS = [
  /^sign in/i, /^log\s?in/i, /^subscribe/i, /^loading\b/i,
  /^read more/i, /^continue reading/i, /^advertisement/i,
  /^cookie/i, /^privacy/i, /^terms of/i, /^accept/i,
  /^skip to/i, /^menu/i, /^home$/i, /^search$/i,
  /^next$/i, /^prev/i, /^back$/i,
];
function samplesLookReal(samples) {
  if (!Array.isArray(samples) || samples.length < SAMPLE_MIN_COUNT) return false;
  let realCount = 0;
  const seenTitles = new Set();
  for (const s of samples) {
    const t = (s.title || '').trim();
    if (t.length < SAMPLE_TITLE_MIN_LEN || t.length > SAMPLE_TITLE_MAX_LEN) continue;
    if (JUNK_TITLE_PATTERNS.some(rx => rx.test(t))) continue;
    if (seenTitles.has(t.toLowerCase())) continue;
    seenTitles.add(t.toLowerCase());
    realCount++;
  }
  return realCount >= SAMPLE_MIN_COUNT;
}

// ─── DB ops ────────────────────────────────────────────────────────────
async function applyToDb(source, det) {
  await pool.query(`
    UPDATE news_sources SET
      source_type    = $1,
      scrape_url     = $2,
      scrape_config  = $3,
      rss_url        = COALESCE($4, rss_url),
      is_active      = true,
      failure_count  = 0,
      last_error     = NULL,
      last_failed_at = NULL
    WHERE id = $5
  `, [det.type, det.scrape_url, det.config ? JSON.stringify(det.config) : null, det.rss_url || null, source.id]);
}
async function deleteSource(id) {
  await pool.query(`DELETE FROM news_sources WHERE id = $1`, [id]);
}

// ─── Main loop ─────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`[auto-test] starting at ${new Date().toISOString()}`);
  console.log(`[auto-test] mode: ${DRY ? 'DRY RUN (no DB writes)' : 'LIVE'}, threshold: ${CONFIDENCE_THRESHOLD}%`);

  let where = `is_active = false AND site_url IS NOT NULL AND site_url != ''`;
  const params = [];
  if (ID_FILTER) {
    where += ` AND id = ANY($${params.length + 1}::int[])`;
    params.push(ID_FILTER);
  }
  if (NEVER_FETCHED_ONLY) {
    where += ` AND last_success_at IS NULL`;
  }
  const orderLim = LIMIT > 0 ? ` ORDER BY id DESC LIMIT ${LIMIT}` : ` ORDER BY id DESC`;
  const { rows: sources } = await pool.query(`
    SELECT id, name, site_url, rss_url, language, country_id, city_id, last_success_at
      FROM news_sources
     WHERE ${where}
     ${orderLim}
  `, params);
  console.log(`[auto-test] queue: ${sources.length} sources`);
  if (!sources.length) { console.log(`[auto-test] nothing to do`); await pool.end().catch(() => {}); return; }

  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'tmp', `auto-test-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'results.jsonl');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  let added = 0, deleted = 0, leftInactive = 0, errored = 0;
  const start = Date.now();

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const stepStart = Date.now();
    let det = null, decision = 'skip', reason = '';

    try {
      // Per-source 60s ceiling — total run = ~N * up-to-60s. With N=300
      // that's a 5-hour worst case, but average is more like 5-10s.
      det = await Promise.race([
        detectSource(s),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60000)),
      ]);
    } catch (e) {
      det = { type: null, reason: `crash: ${e.message}` };
      errored++;
    }

    if (!det.type) {
      decision = 'delete';
      reason   = det.reason || 'no method';
    } else if (det.confidence >= CONFIDENCE_THRESHOLD) {
      decision = 'add';
      reason   = `confidence ${det.confidence}% >= ${CONFIDENCE_THRESHOLD}`;
    } else if (samplesLookReal(det.samples)) {
      decision = 'add';
      reason   = `confidence ${det.confidence}% but ${det.samples.length} real-looking samples`;
    } else {
      decision = 'leave';
      reason   = `confidence ${det.confidence}%, samples didn't pass quality check`;
    }

    if (!DRY) {
      try {
        if (decision === 'add')    { await applyToDb(s, det);     added++; }
        else if (decision === 'delete') { await deleteSource(s.id); deleted++; }
        else                       { leftInactive++; }
      } catch (e) {
        decision = 'error';
        reason   = `db error: ${e.message}`;
        errored++;
      }
    } else {
      if (decision === 'add')    added++;
      else if (decision === 'delete') deleted++;
      else                       leftInactive++;
    }

    const stepMs = Date.now() - stepStart;
    const logLine = {
      ts: new Date().toISOString(),
      id: s.id,
      name: s.name,
      site_url: s.site_url,
      detected_type: det.type,
      confidence: det.confidence,
      decision,
      reason,
      samples_count: det.samples?.length || 0,
      step_ms: stepMs,
    };
    logStream.write(JSON.stringify(logLine) + '\n');

    const elapsedM = ((Date.now() - start) / 60000).toFixed(1);
    const pct = Math.round(((i + 1) / sources.length) * 100);
    console.log(`[${i + 1}/${sources.length} ${pct}% · ${elapsedM}m] #${s.id} ${(s.name || '').slice(0, 40).padEnd(40)} → ${decision.toUpperCase().padEnd(6)} (${det.type || '—'}, ${det.confidence ?? '—'}%) ${reason}`);
  }

  logStream.end();
  const summary = {
    ts: new Date().toISOString(),
    queue_size: sources.length,
    added, deleted, left_inactive: leftInactive, errored,
    elapsed_secs: ((Date.now() - t0) / 1000).toFixed(1),
    output_dir: outDir,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n[auto-test] done in ${summary.elapsed_secs}s`);
  console.log(`[auto-test] added: ${added} | deleted: ${deleted} | left_inactive: ${leftInactive} | errored: ${errored}`);
  console.log(`[auto-test] log: ${logPath}`);

  await pool.end().catch(() => {});
}

main().catch(e => { console.error('[auto-test] fatal:', e); process.exit(1); });
