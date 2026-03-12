/**
 * keywordExtractor.js
 *
 * Shared keyword extraction module used by:
 *   - backfillKeywords.js  (one-time historical pass)
 *   - fetcher.js           (per-article at ingest time)
 *
 * For each article, returns up to MAX_KEYWORDS scored keywords
 * and up to MAX_BIGRAMS scored bigrams, stopword-filtered,
 * with title words boosted 3× over body words.
 */

'use strict';

const pool = require('./db');

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_KEYWORDS  = 25;   // unigrams stored per article
const MAX_BIGRAMS   = 10;   // bigrams stored per article (counted toward the 25)
const TITLE_BOOST   = 3;    // multiplier for words found in the title
const MIN_WORD_LEN  = 3;    // skip tokens shorter than this

// ─── Stopword cache ────────────────────────────────────────────────────────
// Loaded once from DB on first use, keyed by language code.
// 'all' = universal noise list applied to every language.

let stopwordCache = null;   // { [lang]: Set<string>, all: Set<string> }
let cacheLoadedAt = null;

async function loadStopwords() {
  if (stopwordCache && Date.now() - cacheLoadedAt < 60 * 60 * 1000) {
    return stopwordCache;
  }
  const { rows } = await pool.query('SELECT word, language FROM stopwords');
  const cache = {};
  for (const { word, language } of rows) {
    if (!cache[language]) cache[language] = new Set();
    cache[language].add(word.toLowerCase());
  }
  stopwordCache = cache;
  cacheLoadedAt = Date.now();
  return cache;
}

function isStopword(token, lang, cache) {
  return (
    (cache['all']  && cache['all'].has(token))  ||
    (cache[lang]   && cache[lang].has(token))   ||
    (cache['en']   && cache['en'].has(token))      // English always applied as fallback
  );
}

// ─── Tokeniser ─────────────────────────────────────────────────────────────
// Works for space-segmented scripts (Latin, Cyrillic, Arabic, etc.)
// CJK (zh, ja, ko) and scripts without spaces (th, km, lo) are handled
// separately with a simple character n-gram fallback since we don't want
// to pull in a heavy NLP dependency.

const CJK_LANGS    = new Set(['zh', 'ja', 'ko']);
const NOSPACE_LANGS = new Set(['th', 'km', 'lo']);

function tokenise(text, lang) {
  if (!text) return [];

  if (CJK_LANGS.has(lang) || NOSPACE_LANGS.has(lang)) {
    // For scripts without spaces: extract character bigrams and trigrams
    // as proxy tokens. Not perfect but better than no segmentation.
    const clean = text.replace(/\s+/g, '');
    const tokens = [];
    for (let i = 0; i < clean.length - 1; i++) {
      if (i + 2 <= clean.length) tokens.push(clean.slice(i, i + 2));
      if (i + 3 <= clean.length) tokens.push(clean.slice(i, i + 3));
    }
    return tokens;
  }

  // For all other scripts: split on whitespace and punctuation
  return text
    .toLowerCase()
    .split(/[\s\u00A0\u200B]+/)                     // whitespace incl. NBSP/ZWSP
    .map(t => t.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))  // strip leading/trailing punct
    .filter(t => t.length >= MIN_WORD_LEN);
}

// ─── Bigram builder ────────────────────────────────────────────────────────
// Only pairs two consecutive non-stopword tokens.

function buildBigrams(tokens, lang, cache) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (
      a.length >= MIN_WORD_LEN &&
      b.length >= MIN_WORD_LEN &&
      !isStopword(a, lang, cache) &&
      !isStopword(b, lang, cache)
    ) {
      bigrams.push(`${a} ${b}`);
    }
  }
  return bigrams;
}

// ─── Score accumulator ─────────────────────────────────────────────────────

function scoreTokens(tokens, boost) {
  const scores = {};
  for (const token of tokens) {
    scores[token] = (scores[token] || 0) + boost;
  }
  return scores;
}

function mergeScores(base, extra) {
  for (const [k, v] of Object.entries(extra)) {
    base[k] = (base[k] || 0) + v;
  }
  return base;
}

// ─── Main extraction function ───────────────────────────────────────────────
/**
 * extractKeywords(article, lang, stopwordCache)
 *
 * @param {object} article  - { title, summary } (summary = article body/description)
 * @param {string} lang     - ISO 639-1 language code, e.g. 'en', 'ar', 'ru'
 * @param {object} cache    - stopword cache from loadStopwords()
 *
 * @returns {Array<{ keyword: string, frequency: number, is_bigram: boolean }>}
 *   Sorted by frequency descending, capped at MAX_KEYWORDS total
 *   (up to MAX_BIGRAMS of which may be bigrams).
 */
function extractKeywords(article, lang, cache) {
  const titleText   = article.title   || '';
  const bodyText    = article.summary || '';

  // ── Tokenise title and body separately
  const titleTokens = tokenise(titleText, lang);
  const bodyTokens  = tokenise(bodyText,  lang);

  // ── Filter stopwords from each
  const cleanTitle = titleTokens.filter(t => !isStopword(t, lang, cache));
  const cleanBody  = bodyTokens.filter(t =>  !isStopword(t, lang, cache));

  // ── Score unigrams: title tokens get TITLE_BOOST, body tokens get 1
  let unigramScores = {};
  mergeScores(unigramScores, scoreTokens(cleanTitle, TITLE_BOOST));
  mergeScores(unigramScores, scoreTokens(cleanBody,  1));

  // ── Score bigrams: built from full token stream (title then body)
  const allTokens   = [...titleTokens, ...bodyTokens];
  const bigramList  = buildBigrams(allTokens, lang, cache);
  // Title bigrams get boost too: count bigrams from title with TITLE_BOOST
  const titleBigrams = buildBigrams(titleTokens, lang, cache);
  const bodyBigrams  = buildBigrams(bodyTokens,  lang, cache);

  let bigramScores = {};
  mergeScores(bigramScores, scoreTokens(titleBigrams, TITLE_BOOST));
  mergeScores(bigramScores, scoreTokens(bodyBigrams,  1));

  // ── Sort and cap
  const topUnigrams = Object.entries(unigramScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS - MAX_BIGRAMS)  // leave room for bigrams
    .map(([keyword, frequency]) => ({ keyword, frequency, is_bigram: false }));

  const topBigrams = Object.entries(bigramScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_BIGRAMS)
    .map(([keyword, frequency]) => ({ keyword, frequency, is_bigram: true }));

  // ── Merge, re-sort, final cap at MAX_KEYWORDS
  return [...topUnigrams, ...topBigrams]
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, MAX_KEYWORDS);
}

// ─── DB write helper ────────────────────────────────────────────────────────
/**
 * saveKeywords(articleId, keywords, lang, client?)
 *
 * Inserts extracted keywords into article_keywords.
 * Also updates keyword_daily_stats and keyword_cooccurrence.
 * Pass an existing pg client for transaction support (backfill),
 * or omit to use the pool directly (fetcher).
 *
 * @param {number}  articleId
 * @param {Array}   keywords   - output of extractKeywords()
 * @param {string}  lang
 * @param {Date}    publishedAt
 * @param {number|null} sourceCountryId
 * @param {number|null} aboutCountryId
 * @param {object}  [client]   - optional pg client
 */
async function saveKeywords(
  articleId,
  keywords,
  lang,
  publishedAt,
  sourceCountryId   = null,
  aboutCountryId    = null,
  client            = undefined,
  skipCooccurrence  = false
) {
  if (!keywords || keywords.length === 0) return;
  const db   = client || pool;
  const date = publishedAt
    ? new Date(publishedAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // ── 1. Bulk insert into article_keywords (single query)
  const akVals   = keywords.map((_, i) => `($1, $${i*3+2}, $${i*3+3}, $${i*3+4})`).join(',');
  const akParams = [articleId];
  for (const { keyword, frequency } of keywords) {
    akParams.push(keyword, lang, frequency);
  }
  await db.query(
    `INSERT INTO article_keywords (article_id, keyword, source_language, frequency)
     VALUES ${akVals}
     ON CONFLICT DO NOTHING`,
    akParams
  );

  // ── 2. Bulk upsert keyword_daily_stats — global rows
  const globalVals   = keywords.map((_, i) => `($${i*2+1}, $${i*2+2}, 1, 1, NULL, NULL)`).join(',');
  const globalParams = [];
  for (const { keyword } of keywords) globalParams.push(keyword, date);
  await db.query(
    `INSERT INTO keyword_daily_stats
       (keyword, date, total_count, language_group_count, source_country_id, about_country_id)
     VALUES ${globalVals}
     ON CONFLICT (keyword, date, source_country_id, about_country_id)
     DO UPDATE SET
       total_count          = keyword_daily_stats.total_count + 1,
       language_group_count = keyword_daily_stats.language_group_count + 1`,
    globalParams
  );

  // ── 3. Bulk upsert keyword_daily_stats — country rows (if we have country context)
  if (sourceCountryId || aboutCountryId) {
    const cVals   = keywords.map((_, i) => `($${i*2+1}, $${i*2+2}, 1, 1, $${keywords.length*2+1}, $${keywords.length*2+2})`).join(',');
    const cParams = [];
    for (const { keyword } of keywords) cParams.push(keyword, date);
    cParams.push(sourceCountryId || null, aboutCountryId || null);
    await db.query(
      `INSERT INTO keyword_daily_stats
         (keyword, date, total_count, language_group_count, source_country_id, about_country_id)
       VALUES ${cVals}
       ON CONFLICT (keyword, date, source_country_id, about_country_id)
       DO UPDATE SET
         total_count          = keyword_daily_stats.total_count + 1,
         language_group_count = keyword_daily_stats.language_group_count + 1`,
      cParams
    );
  }

  // ── 4. Bulk insert keyword_cooccurrence pairs (skipped if skipCooccurrence=true)
  if (skipCooccurrence) return;
  // Dedupe keywords first (bigrams + unigrams can overlap), then pair
  const words = [...new Set(keywords.map(k => k.keyword))];
  const pairs = [];
  const seenPairs = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      if (words[i] === words[j]) continue;  // skip identical
      const [a, b] = words[i] < words[j] ? [words[i], words[j]] : [words[j], words[i]];
      const key = `${a}||${b}`;
      if (seenPairs.has(key)) continue;     // skip duplicate pairs
      seenPairs.add(key);
      pairs.push([a, b]);
    }
  }
  if (pairs.length > 0) {
    // Use LEAST/GREATEST in SQL to guarantee keyword_a < keyword_b
    // regardless of JS vs Postgres collation differences
    const pVals   = pairs.map((_, i) => `(LEAST($${i*4+1},$${i*4+2}), GREATEST($${i*4+1},$${i*4+2}), $${i*4+3}, $${i*4+4})`).join(',');
    const pParams = [];
    for (const [a, b] of pairs) {
      if (a === b) continue;  // final safety: skip identical
      pParams.push(a, b, articleId, date);
    }
    // Rebuild vals to match filtered pParams
    const filteredCount = pParams.length / 4;
    if (filteredCount > 0) {
      const fVals = Array.from({length: filteredCount}, (_, i) =>
        `(LEAST($${i*4+1},$${i*4+2}), GREATEST($${i*4+1},$${i*4+2}), $${i*4+3}::integer, $${i*4+4}::date)`
      ).join(',');
      await db.query(
        `INSERT INTO keyword_cooccurrence (keyword_a, keyword_b, article_id, date)
         SELECT v.a, v.b, v.article_id, v.date
         FROM (VALUES ${fVals}) AS v(a, b, article_id, date)
         WHERE v.a < v.b
         ON CONFLICT DO NOTHING`,
        pParams
      );
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

module.exports = {
  loadStopwords,
  extractKeywords,
  saveKeywords,
};