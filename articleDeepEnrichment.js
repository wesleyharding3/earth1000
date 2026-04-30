/**
 * articleDeepEnrichment.js — CONSOLIDATED DEEP ENRICHMENT PIPELINE
 *
 * Replaces two redundant pipelines that were doing the same work:
 *
 *   (1) deepAnalyzer.js — scrape → Haiku → sentiment + entities, writing
 *       sentiment to news_articles.sentiment_score and entities to the
 *       article_entities table that nothing in the codebase actually
 *       reads from. Write-only table. Sunk cost.
 *
 *   (2) briefingGenerator._deepEnrichThread — scrape → Haiku → keywords,
 *       entities, relationships, background. Lives only in RAM as
 *       thread.deepContext, gets fed into the voiceover Sonnet prompt,
 *       then discarded. Re-done from scratch every briefing run,
 *       re-scraping the same URLs (1) just scraped, re-paying Claude for
 *       overlapping work.
 *
 * This module does the scrape + Haiku call ONCE per article, persists
 * the full structured output to article_deep_context, and is the single
 * source both consumers now read from:
 *
 *   storyThreadBuilder → calls enrichArticle() for top-N articles per
 *     active/cooling thread at end of run. Also reads primary_nations
 *     from freshly-analyzed articles to populate story_threads
 *     .primary_nations on thread create / extend (plugs the "NULL
 *     primary_nations" hole from the audit).
 *
 *   briefingGenerator → replaces _deepEnrichThread with a DB read
 *     via loadContextForArticles(). No more scraping at briefing time,
 *     no more Claude calls at briefing time for deep context. Cached,
 *     fast, cheap.
 *
 * Legacy: deepAnalyzer.js is deprecated but not deleted — dbPruneCron
 * still references article_entities for cascade cleanup. Stub kept at
 * deepAnalyzer.js that re-exports enrichArticle under the old name so
 * nothing explodes if an import slips through.
 */

'use strict';

const https    = require('https');
const http     = require('http');
const cheerio  = require('cheerio');
const pool     = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
// Charset-aware buffer decoder. Previous `.toString('utf8')` forced
// UTF-8 regardless of what the remote source actually sent; Russian /
// CJK / Eastern European articles served in legacy charsets became
// U+FFFD soup, and the deep-enriched output was garbage. decodeBuffer
// sniffs charset from BOM / XML prolog / HTML meta / Content-Type and
// decodes with iconv-lite where needed; throws err.code='MOJIBAKE' on
// unrecoverable input so the enrichment skips instead of persisting.
const { decodeBuffer } = require('./fetchDecode');

const client = new Anthropic();

// ─── Config ──────────────────────────────────────────────────────────────────
const PRIORITY_THRESHOLD = 0.70;
const MAX_PER_DAY        = 2000;
const FETCH_TIMEOUT_MS   = 5000;
const MAX_HTML_BYTES     = 500_000;
const MAX_TEXT_CHARS     = 4000;
const MAX_REDIRECTS      = 3;

// ─── Daily counter ────────────────────────────────────────────────────────────
const _counter = { date: '', count: 0 };
function _allowAndCount() {
  const today = new Date().toISOString().slice(0, 10);
  if (_counter.date !== today) { _counter.date = today; _counter.count = 0; }
  if (_counter.count >= MAX_PER_DAY) return false;
  _counter.count++;
  return true;
}

// ─── HTTP fetch with timeout + redirect follow ────────────────────────────────
function _fetchHTML(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('Too many redirects'));

    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const fail = (err) => { if (!resolved) { resolved = true; reject(err);  } };

    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Earth00/1.0)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en,*;q=0.5',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url).href;
          _fetchHTML(next, redirectsLeft - 1).then(done).catch(fail);
        } catch { fail(new Error(`Bad redirect: ${res.headers.location}`)); }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      const contentType = res.headers?.['content-type'] || null;
      // Decode via fetchDecode.decodeBuffer so non-UTF-8 sources are
      // recognized and routed through iconv-lite, and mojibake fails
      // loudly with err.code='MOJIBAKE' rather than silently producing
      // U+FFFD soup. Outer try/catch on enrichArticle treats this as a
      // scrape failure → falls back to content column → summary.
      const _decodeSafe = (buf) => {
        try { return decodeBuffer(buf, contentType, { urlForLog: url }); }
        catch (err) {
          if (err?.code === 'MOJIBAKE') {
            // Surface as a scrape-failure error so the caller falls
            // through the same path it would for HTTP 404 etc.
            throw new Error(`Mojibake (bad charset): ${err.charset}`);
          }
          throw err;
        }
      };
      res.on('data', chunk => {
        size += chunk.length;
        chunks.push(chunk);
        if (size >= MAX_HTML_BYTES) {
          req.destroy();
          try { done(_decodeSafe(Buffer.concat(chunks))); }
          catch (err) { fail(err); }
        }
      });
      res.on('end', () => {
        try { done(_decodeSafe(Buffer.concat(chunks))); }
        catch (err) { fail(err); }
      });
      res.on('error', fail);
    });
    req.on('timeout', () => { req.destroy(); fail(new Error('Fetch timeout')); });
    req.on('error',   fail);
  });
}

// ─── Article-body extraction ──────────────────────────────────────────────────
function _extractText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,header,footer,aside,iframe,.ad,.ads,.advertisement,.promo,.social,.share,.comments,.related,.sidebar,.newsletter,.paywall,.subscription').remove();

  const SELECTORS = [
    'article [itemprop="articleBody"]',
    '[itemprop="articleBody"]',
    'article',
    '[role="article"]',
    '.article-body', '.article-content', '.article__body', '.article__content',
    '.post-body', '.post-content', '.post__content',
    '.entry-content', '.entry-body',
    '.story-body', '.story-content', '.story__body',
    '.content-body', '.body-content',
    '.news-content', '.news-body',
    'main',
  ];

  for (const sel of SELECTORS) {
    const text = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (text.length > 200) return text;
  }
  return $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(t => t.length > 40)
    .join(' ');
}

// ─── Tolerant JSON extractor ──────────────────────────────────────────────────
// Same pattern as keywordNormalizer after the Claude-wraps-in-fences fix:
// strip markdown fences, try whole-body parse, fall back to first balanced
// brace-match. Old deepAnalyzer's regex-only parse silently ate every
// fenced response — unclear what percentage of runs that was but even a
// few percent adds up.
function _extractJsonObject(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  try { return JSON.parse(text); } catch (_) {}
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (_) {}
  }
  return null;
}

// ─── Unified Claude call ──────────────────────────────────────────────────────
// Single prompt pulls everything both consumers need. Doing it as one
// structured JSON output means a per-article call costs ~1 k input +
// ~800 output tokens on Haiku, or about $0.005. Do it ~500-800 times per
// day and the deep-enrichment bill is well under $5/day.
async function _runUnifiedNLP(title, text) {
  const excerpt = text.slice(0, MAX_TEXT_CHARS);

  const prompt =
`Analyze this news article. Return ONLY a valid JSON object, no explanation, no markdown fences.

Title: ${title}
Text: ${excerpt}

Return exactly:
{
  "sentiment": <float -1.0 to 1.0; -1=crisis/conflict, 0=neutral, 1=progress/resolution>,
  "keywords": ["5-10 substantive terms adding context beyond the title"],
  "entities": [{"text":"<proper name>","type":"<person|organization|location|event>","relevance":<0.0-1.0>}],
  "relationships": ["2-3 concrete cause-effect or political relationships, e.g. 'Country X sanctions Y because Z'"],
  "background": "1-2 sentences of deeper geopolitical, historical, or legal context a briefing writer should know",
  "primary_nations": ["ISO-3166 alpha-2 codes of 0-6 countries central to the story, ordered by centrality — empty array if the story has no national actor"]
}

Rules:
- sentiment reflects article tone, not topic
- entities: up to 15, proper names only, no duplicates
- keywords: concrete terms, not generic ("trade war", not "news")
- primary_nations: only countries that are ACTORS or SETTING, not countries merely name-dropped
- Return ONLY the JSON object`;

  const res = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 900,
    messages:   [{ role: 'user', content: prompt }],
  });
  const raw = res.content?.[0]?.text || '';
  const parsed = _extractJsonObject(raw);
  if (!parsed) throw new Error(`No JSON in Haiku response: ${raw.slice(0, 200)}`);
  return parsed;
}

// ─── Persist ──────────────────────────────────────────────────────────────────
const VALID_ENTITY_TYPES = new Set(['person','organization','location','event']);
function _sanitizeEntities(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(e => e && e.text && VALID_ENTITY_TYPES.has(e.type))
    .map(e => ({
      text:      String(e.text).slice(0, 200),
      type:      e.type,
      relevance: Math.max(0, Math.min(1, parseFloat(e.relevance) || 0.5)),
    }))
    .slice(0, 15);
}
function _sanitizeIsoCodes(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const code = String(raw || '').trim().toUpperCase();
    // ISO-3166 alpha-2 is exactly 2 letters. Reject anything else so
    // Claude hallucinating "EU" or "UN" or "1234" gets dropped.
    if (!/^[A-Z]{2}$/.test(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 6) break;
  }
  return out;
}
function _sanitizeStringArray(arr, { max = 12, maxLen = 400 } = {}) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const v = String(raw || '').trim();
    if (!v || v.length > maxLen) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ─── KILL SWITCH ──────────────────────────────────────────────────────────────
// Disabled 20260430 to cut Anthropic API spend. Per the audit:
//   - sentiment_score is already populated by sentimentLexicon.js (free, lexicon)
//   - keywords are already extracted in fetcher.js (per-article Haiku, 200 tok)
//     and re-normalized by storyThreadBuilder
//   - entities are already extracted in entityExtractor.js (batched Haiku) from
//     articleListener
//   - relationships + background are unique to this module BUT only consumed by
//     briefingGenerator, which we are not actively shipping
//   - primary_nations is the only live-UX-relevant output; it backfills NULLs
//     left by storyThreadBuilder's batch call. Acceptable to skip; thread-builder
//     produces primary_nations directly in its own batch prompt.
// Set ENABLE_DEEP_ENRICHMENT=1 in env to re-enable. Read paths
// (loadContextForArticles, aggregateThreadContext) remain live so existing
// data in article_deep_context is still consumable.
const DEEP_ENRICHMENT_ENABLED = process.env.ENABLE_DEEP_ENRICHMENT === '1';

// ─── Main export: enrichArticle ───────────────────────────────────────────────
async function enrichArticle(articleId, { skipThreshold = false } = {}) {
  const tag = `[deep:${articleId}]`;
  // Hard short-circuit — return null (same contract as the existing skip
  // paths: priority threshold, daily cap, missing article). No Claude call,
  // no scrape, no DB write.
  if (!DEEP_ENRICHMENT_ENABLED) return null;
  try {
    // ── 1. Load article ──────────────────────────────────────────────────────
    const { rows } = await pool.query(`
      SELECT id, title, translated_title, summary, translated_summary,
             content, article_url, base_priority, deep_analyzed_at
      FROM news_articles WHERE id = $1
    `, [articleId]);
    if (!rows.length) return null;
    const art = rows[0];

    // ── 2. Gates ─────────────────────────────────────────────────────────────
    if (!skipThreshold && (art.base_priority || 0) < PRIORITY_THRESHOLD) return null;
    if (art.deep_analyzed_at) return null; // idempotent — reads should use
                                           // loadContextForArticles instead
    if (!_allowAndCount()) {
      console.log(`${tag} Daily cap reached — skipping`);
      return null;
    }

    // ── 3. Get article text (scrape → content col → summary) ─────────────────
    let articleText = '';
    let textSource  = '';

    if (art.article_url) {
      try {
        console.log(`${tag} Fetching full article text for deep enrichment`);
        const html      = await _fetchHTML(art.article_url);
        const extracted = _extractText(html);
        if (extracted.length > 200) {
          articleText = extracted;
          textSource  = 'scrape';
        }
      } catch (err) {
        console.log(`${tag} Scrape failed (${err.message}) — falling back`);
      }
    }
    if (!articleText && art.content && art.content.length > 200) {
      articleText = art.content;
      textSource  = 'content_col';
    }
    if (!articleText) {
      const summary = art.translated_summary || art.summary || '';
      if (summary.length > 50) {
        articleText = summary;
        textSource  = 'summary';
      }
    }
    if (!articleText) {
      console.log(`${tag} No usable text — skipping`);
      return null;
    }

    // Cache the scraped text on news_articles.content so briefings and
    // the thread-builder's context refresh can re-use it without
    // re-fetching. Briefing generator was doing this already; port the
    // behavior here too.
    if (textSource === 'scrape' && (!art.content || art.content.length < 300)) {
      pool.query(
        `UPDATE news_articles SET content = $1 WHERE id = $2`,
        [articleText.slice(0, 8000), articleId]
      ).catch(() => {});
    }

    // ── 4. Claude ────────────────────────────────────────────────────────────
    const title  = art.translated_title || art.title || '';
    const result = await _runUnifiedNLP(title, articleText);

    // ── 5. Normalize outputs ────────────────────────────────────────────────
    const sentiment = (typeof result.sentiment === 'number')
      ? Math.max(-1, Math.min(1, result.sentiment))
      : null;
    const keywords       = _sanitizeStringArray(result.keywords,       { max: 12, maxLen: 120 });
    const entities       = _sanitizeEntities(result.entities);
    const relationships  = _sanitizeStringArray(result.relationships,  { max: 5,  maxLen: 400 });
    const background     = String(result.background || '').trim().slice(0, 1200) || null;
    const primaryNations = _sanitizeIsoCodes(result.primary_nations);

    // ── 6. Persist (single transaction) ─────────────────────────────────────
    const txClient = await pool.connect();
    try {
      await txClient.query('BEGIN');

      // Write the sentiment + idempotency marker back onto news_articles
      // (keeps the sentiment_score column populated — all the UI and
      // heatmap code continues to read it from there, no read-side change).
      await txClient.query(`
        UPDATE news_articles
           SET sentiment_score  = COALESCE($1, sentiment_score),
               deep_analyzed_at = NOW()
         WHERE id = $2
      `, [sentiment, articleId]);

      // Upsert the consolidated row. Existing rows get re-written so
      // re-running enrichArticle on an article refreshes its context.
      await txClient.query(`
        INSERT INTO article_deep_context (
          article_id, keywords, entities, relationships,
          background, primary_nations, scrape_source, analyzed_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW())
        ON CONFLICT (article_id) DO UPDATE SET
          keywords        = EXCLUDED.keywords,
          entities        = EXCLUDED.entities,
          relationships   = EXCLUDED.relationships,
          background      = EXCLUDED.background,
          primary_nations = EXCLUDED.primary_nations,
          scrape_source   = EXCLUDED.scrape_source,
          analyzed_at     = NOW()
      `, [
        articleId,
        keywords,
        JSON.stringify(entities),
        relationships,
        background,
        primaryNations,
        textSource
      ]);

      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      txClient.release();
    }

    console.log(
      `🔬 Deep enrich [${articleId}] src=${textSource} ` +
      `sent=${sentiment?.toFixed(2) ?? 'n/a'} ` +
      `kw=${keywords.length} ent=${entities.length} rel=${relationships.length} ` +
      `nat=[${primaryNations.join(',')}] ` +
      `(${_counter.count}/${MAX_PER_DAY} today)`
    );

    return {
      article_id:      articleId,
      keywords,
      entities,
      relationships,
      background,
      primary_nations: primaryNations,
      scrape_source:   textSource,
    };

  } catch (err) {
    // Never throw — must not affect caller pipelines
    console.warn(`${tag} Failed: ${err.message}`);
    return null;
  }
}

// ─── Batch read helper ────────────────────────────────────────────────────────
// Replaces briefingGenerator._deepEnrichThread's Claude pass. Callers
// pass a list of article_ids; we return Map<id, context>. Missing IDs
// (articles not yet enriched) simply aren't in the map — caller handles
// degraded context gracefully.
async function loadContextForArticles(articleIds) {
  const ids = (articleIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`
    SELECT article_id, keywords, entities, relationships, background,
           primary_nations, scrape_source, analyzed_at
    FROM article_deep_context
    WHERE article_id = ANY($1::bigint[])
  `, [ids]);
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.article_id), {
      article_id:      Number(r.article_id),
      keywords:        Array.isArray(r.keywords) ? r.keywords : [],
      entities:        Array.isArray(r.entities) ? r.entities : (r.entities || []),
      relationships:   Array.isArray(r.relationships) ? r.relationships : [],
      background:      r.background || null,
      primary_nations: Array.isArray(r.primary_nations) ? r.primary_nations : [],
      scrape_source:   r.scrape_source || null,
      analyzed_at:     r.analyzed_at,
    });
  }
  return map;
}

// ─── Thread-level aggregation helper ──────────────────────────────────────────
// Converts per-article contexts into the shape briefingGenerator's
// voiceover prompt expects (thread.deepContext with keys
// key_keywords, key_entities, relationships, background). Programmatic
// aggregation — no Claude call — since article-level context is already
// Claude-synthesized.
function aggregateThreadContext(articleContexts) {
  const ctxs = Array.isArray(articleContexts)
    ? articleContexts
    : [...(articleContexts?.values?.() || [])];
  if (!ctxs.length) return null;

  const kwSet = new Set();
  const entByText = new Map();
  const relSet = new Set();
  const backgrounds = [];

  for (const c of ctxs) {
    for (const k of c.keywords || []) {
      const key = String(k || '').toLowerCase();
      if (!key || kwSet.has(key)) continue;
      kwSet.add(key);
    }
    for (const e of c.entities || []) {
      if (!e?.text) continue;
      const key = `${e.type}:${String(e.text).toLowerCase()}`;
      if (!entByText.has(key)) {
        entByText.set(key, { text: e.text, type: e.type, relevance: e.relevance || 0.5 });
      } else {
        // Take max relevance across articles — boosted by repeated mentions
        const cur = entByText.get(key);
        cur.relevance = Math.max(cur.relevance, e.relevance || 0.5);
      }
    }
    for (const r of c.relationships || []) {
      const key = String(r || '').trim();
      if (!key) continue;
      // Dedupe on a lowercased prefix to absorb minor rewordings
      const dedupKey = key.slice(0, 60).toLowerCase();
      if (relSet.has(dedupKey)) continue;
      relSet.add(dedupKey);
    }
    if (c.background) backgrounds.push(c.background);
  }

  // Choose one background: the longest, since Claude gave it the most
  // room for context. Cheap heuristic; works because per-article
  // backgrounds are already capped at 1200 chars.
  const background = backgrounds.sort((a, b) => b.length - a.length)[0] || null;

  // Return in the shape briefingGenerator's voiceover prompt expects
  // so the consumer contract stays identical to what _deepEnrichThread
  // produced — just sourced from cache instead of a fresh Claude call.
  return {
    key_keywords:  [...kwSet].slice(0, 10),
    key_entities:  [...entByText.values()]
                     .sort((a, b) => b.relevance - a.relevance)
                     .slice(0, 12)
                     .map(e => e.text),
    relationships: [...relSet].slice(0, 5),
    background,
    scraped_count: ctxs.length,
  };
}

module.exports = {
  enrichArticle,
  loadContextForArticles,
  aggregateThreadContext,
  // Back-compat alias so the old call sites still function during rollout
  deepAnalyzeArticle: enrichArticle,
};
