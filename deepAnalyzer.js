/**
 * deepAnalyzer.js
 *
 * Deep NLP analysis for high-priority articles.
 * Runs fire-and-forget from articleListener — never blocks the main pipeline.
 *
 * Pipeline per article:
 *   1. Check base_priority >= PRIORITY_THRESHOLD and daily cap not exceeded
 *   2. Fetch full article text from article_url (5s timeout)
 *   3. Fallback chain: scrape → content column → summary
 *   4. Single Claude Haiku call → sentiment + entities + keywords
 *   5. Write: news_articles.sentiment_score, news_articles.deep_analyzed_at,
 *             article_entities rows
 *
 * Rate limits:
 *   - PRIORITY_THRESHOLD: only articles scoring >= 0.70
 *   - MAX_PER_DAY: hard cap of 2000 deep analyses per calendar day (resets at midnight)
 */

'use strict';

const https    = require('https');
const http     = require('http');
const cheerio  = require('cheerio');
const pool     = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

// ─── Config ──────────────────────────────────────────────────────────────────
const PRIORITY_THRESHOLD = 0.70;   // base_priority floor to qualify
const MAX_PER_DAY        = 2000;   // max deep analyses per calendar day
const FETCH_TIMEOUT_MS   = 5000;   // max ms to wait for article HTML
const MAX_HTML_BYTES     = 500_000; // bail out after 500KB of HTML
const MAX_TEXT_CHARS     = 4000;   // ~800 words fed to Haiku (~1k input tokens)
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
      // Follow redirects
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
      res.on('data', chunk => {
        size += chunk.length;
        chunks.push(chunk);
        if (size >= MAX_HTML_BYTES) { req.destroy(); done(Buffer.concat(chunks).toString('utf8')); }
      });
      res.on('end',   () => done(Buffer.concat(chunks).toString('utf8')));
      res.on('error', fail);
    });

    req.on('timeout', () => { req.destroy(); fail(new Error('Fetch timeout')); });
    req.on('error',   fail);
  });
}

// ─── Extract main article text from raw HTML ──────────────────────────────────
function _extractText(html) {
  const $ = cheerio.load(html);

  // Strip noise
  $('script,style,noscript,nav,header,footer,aside,iframe,' +
    '.ad,.ads,.advertisement,.promo,.social,.share,.comments,' +
    '.related,.sidebar,.newsletter,.paywall,.subscription').remove();

  // Try known article-body selectors, most specific first
  const SELECTORS = [
    'article [itemprop="articleBody"]',
    '[itemprop="articleBody"]',
    'article',
    '[role="article"]',
    '.article-body',  '.article-content',  '.article__body', '.article__content',
    '.post-body',     '.post-content',     '.post__content',
    '.entry-content', '.entry-body',
    '.story-body',    '.story-content',    '.story__body',
    '.content-body',  '.body-content',
    '.news-content',  '.news-body',
    'main',
  ];

  for (const sel of SELECTORS) {
    const text = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (text.length > 200) return text;
  }

  // Last resort: join all substantial paragraphs
  return $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(t => t.length > 40)
    .join(' ');
}

// ─── Claude Haiku NLP call ────────────────────────────────────────────────────
async function _runNLP(title, text) {
  const excerpt = text.slice(0, MAX_TEXT_CHARS);

  const prompt =
`Analyze this news article. Return ONLY a valid JSON object, no explanation.

Title: ${title}
Text: ${excerpt}

Return exactly:
{
  "sentiment": <float -1.0 to 1.0; -1=strongly negative/crisis/conflict, 0=neutral, 1=strongly positive/progress/resolution>,
  "entities": [{"text":"<name>","type":"<person|organization|location|event>","relevance":<0.0-1.0>}],
  "keywords": ["<term>"]
}

Rules:
- sentiment reflects the article tone, not just the topic
- entities: up to 15, most prominent first, no duplicates, proper names only
- keywords: 5-10 substantive terms adding context beyond the title
- Return ONLY the JSON object`;

  const res  = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw   = res.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Haiku response');
  return JSON.parse(match[0]);
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function deepAnalyzeArticle(articleId) {
  const tag = `[deep:${articleId}]`;
  try {
    // ── 1. Load article ──────────────────────────────────────────────────────
    const { rows } = await pool.query(`
      SELECT id, title, translated_title, summary, translated_summary,
             content, article_url, base_priority, deep_analyzed_at
      FROM news_articles WHERE id = $1
    `, [articleId]);
    if (!rows.length) return;
    const art = rows[0];

    // ── 2. Threshold + already-done check ────────────────────────────────────
    if ((art.base_priority || 0) < PRIORITY_THRESHOLD) return;
    if (art.deep_analyzed_at) return; // idempotent

    // ── 3. Daily cap ─────────────────────────────────────────────────────────
    if (!_allowAndCount()) {
      console.log(`${tag} Daily cap reached — skipping`);
      return;
    }

    // ── 4. Get article text (scrape → content col → summary) ─────────────────
    let articleText = '';
    let textSource  = '';

    // 4a. Scrape full text
    if (art.article_url) {
      try {
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

    // 4b. Content column fallback
    if (!articleText && art.content && art.content.length > 200) {
      articleText = art.content;
      textSource  = 'content_col';
    }

    // 4c. Summary fallback
    if (!articleText) {
      const summary = art.translated_summary || art.summary || '';
      if (summary.length > 50) {
        articleText = summary;
        textSource  = 'summary';
      }
    }

    if (!articleText) {
      console.log(`${tag} No usable text — skipping`);
      return;
    }

    // ── 5. NLP ───────────────────────────────────────────────────────────────
    const title  = art.translated_title || art.title || '';
    const result = await _runNLP(title, articleText);

    // ── 6. Write sentiment + timestamp ───────────────────────────────────────
    const sentiment = (typeof result.sentiment === 'number')
      ? Math.max(-1, Math.min(1, result.sentiment))
      : null;

    await pool.query(`
      UPDATE news_articles
         SET sentiment_score    = COALESCE($1, sentiment_score),
             deep_analyzed_at   = NOW()
       WHERE id = $2
    `, [sentiment, articleId]);

    // ── 7. Write entities ────────────────────────────────────────────────────
    const VALID_TYPES = new Set(['person','organization','location','event']);
    const entities = (Array.isArray(result.entities) ? result.entities : [])
      .filter(e => e.text && VALID_TYPES.has(e.type))
      .slice(0, 15);

    if (entities.length) {
      const vals   = entities.map((_, i) =>
        `($1, $${i*3+2}, $${i*3+3}, $${i*3+4})`
      ).join(',');
      const params = [articleId];
      for (const e of entities) {
        params.push(
          String(e.text).slice(0, 200),
          String(e.type),
          Math.max(0, Math.min(1, parseFloat(e.relevance) || 0.5))
        );
      }
      await pool.query(`
        INSERT INTO article_entities (article_id, entity_text, entity_type, relevance)
        VALUES ${vals}
        ON CONFLICT (article_id, entity_text, entity_type) DO NOTHING
      `, params);
    }

    console.log(
      `🔬 Deep analysis [${articleId}] src=${textSource} ` +
      `sentiment=${sentiment?.toFixed(2) ?? 'n/a'} ` +
      `entities=${entities.length} ` +
      `(${_counter.count}/${MAX_PER_DAY} today)`
    );

  } catch (err) {
    // Never throw — must not affect articleListener pipeline
    console.warn(`${tag} Failed: ${err.message}`);
  }
}

module.exports = { deepAnalyzeArticle };
