// Cap DB pool BEFORE anything requires ./db. Same convention as
// keywordNormalizerCron.js / worker.js: a translator pass needs at
// most 1 client at a time (single GROUP BY query, then DeepL HTTP
// calls), so capping at 2 leaves a generous headroom buffer while
// keeping the web server's pool unstarved on Render.
//
// Critical that this comes before the require('./db') below: db.js
// reads DB_POOL_MAX at module-load time and the value is sticky for
// the rest of the process. If keywordIntelligenceTranslateCron.js
// imports this file, it sets the same cap first, so the second write
// here is a no-op — no conflict.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '2';

// keywordIntelligenceTranslator.js
//
// TACTICAL DeepL backfill for the keyword-intelligence surface (the
// `/api/keywords/trending` / `/rising` / `/top` / `/cooccurrence`
// endpoints). Distinct in scope and intent from the existing Claude-
// based normalizer (`keywordNormalizerCron.js`):
//
//   keywordNormalizerCron — drives storyThreadBuilder cross-language
//     clustering, processes ~5000 keywords/run via Claude Haiku,
//     populates article_keywords.normalized_keyword + a row in
//     keyword_translations for nearly every non-English keyword that
//     hits a frequency floor.
//
//   keywordIntelligenceTranslator (this file) — narrower purpose: the
//     KWI feed is sorted by mention count, so a clean English display
//     only needs the TOP-N keywords translated. Top-N is a tiny
//     fraction of the corpus (~200) that can be DeepL'd in one or two
//     batched calls. DeepL produces tighter, more idiomatic English
//     for short noun phrases than an LLM does, and the cost at this
//     scope is well inside DeepL Pro's free allowance.
//
// Both writers target the same `keyword_translations` table with
// `ON CONFLICT (original_keyword) DO NOTHING`, so they can run side
// by side. The Claude cron does the heavy lifting; this DeepL pass
// just keeps the most-visible end of the distribution clean while the
// hourly Claude cron catches up on the long tail.
//
// Cost note: the previous keywordNormalizerCron docstring estimated
// DeepL at ~$25/day at FULL scope (60K keywords/day). This module's
// scope is bounded to TOP-N (default 200) — three orders of magnitude
// smaller. Even running every hour the bill is fractions of a cent.

'use strict';

require('dotenv').config();

const pool = require('./db');
const deepl = require('deepl-node');

const NON_ASCII = /[^\x00-\x7F]/;

// Defaults — overridable via env so an ops change doesn't need a redeploy.
const DEFAULTS = {
  topN:          parseInt(process.env.KWI_TRANSLATE_TOP_N         || '200', 10),
  lookbackDays:  parseInt(process.env.KWI_TRANSLATE_LOOKBACK_DAYS || '7',   10),
  minFrequency:  parseInt(process.env.KWI_TRANSLATE_MIN_FREQUENCY || '3',   10),
  // DeepL accepts up to 50 strings per call. Keep the per-batch size
  // conservative so one bad string doesn't poison a long batch.
  batchSize:     parseInt(process.env.KWI_TRANSLATE_BATCH_SIZE    || '50',  10),
};

let _translator = null;
function getTranslator() {
  if (_translator) return _translator;
  if (!process.env.DEEPL_API_KEY) {
    throw new Error('DEEPL_API_KEY is not set — cannot run KWI tactical translator.');
  }
  // Pro endpoint matches the rest of the app (translator.js, fetcher.js).
  _translator = new deepl.Translator(
    process.env.DEEPL_API_KEY,
    { serverUrl: 'https://api.deepl.com' }
  );
  return _translator;
}

// Mapping from DeepL's detected source language code (mostly upper-case
// ISO 639-1) to the lower-case form the rest of the app uses.
function normalizeLangCode(code) {
  if (!code) return 'auto';
  return String(code).toLowerCase().slice(0, 5);
}

// A handful of cosmetic guards on a translated keyword. Empty / single-
// char results are nonsense; identical strings are no-ops; very long
// strings indicate DeepL fell back to translating a sentence instead of
// a noun. These rejection paths log NOTHING by design — non-translatable
// strings are common and noisy logging buries the real signals.
function isUsableTranslation(orig, trans) {
  if (!trans) return false;
  const t = String(trans).toLowerCase().trim();
  if (t.length < 2)   return false;
  if (t.length > 200) return false;
  if (t === String(orig).toLowerCase().trim()) return false;
  return true;
}

/**
 * Translate the top-N currently-untranslated non-English KWI keywords
 * via DeepL and write the results to `keyword_translations`.
 *
 * Returns { scanned, translated, batches, skippedAlreadyEn, errors }.
 * Idempotent: ON CONFLICT DO NOTHING means re-running is cheap and
 * non-destructive.
 */
async function translateTopKwiKeywords(opts = {}) {
  const {
    topN          = DEFAULTS.topN,
    lookbackDays  = DEFAULTS.lookbackDays,
    minFrequency  = DEFAULTS.minFrequency,
    batchSize     = DEFAULTS.batchSize,
    logger        = console,
    dryRun        = false,
  } = opts;

  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  // Two-step candidate selection so the planner can use the partial
  // index `idx_kds_global_date_keyword_cover (date DESC, keyword)
  // WHERE source_country_id IS NULL AND about_country_id IS NULL` for
  // the heavy aggregation, then anti-join in JS.
  //
  // The earlier single-query LEFT JOIN against keyword_translations
  // hit statement_timeout because it forced a hash-merge after the
  // GROUP BY, and the planner couldn't push the anti-join down to the
  // index scan. Splitting it lets the GROUP BY run cleanly under the
  // partial index, then the small (5×topN) result set anti-joins fast.
  //
  // We over-fetch by 5× topN to compensate for the keyword that already
  // have translations — they get filtered out below. Given the Claude
  // cron's coverage on common keywords, an over-fetch factor of 5 is
  // usually plenty to surface topN untranslated rows.
  const overfetch = Math.min(topN * 5, 5000);

  // Dedicated connection with extended statement_timeout. Same pattern
  // as keywordNormalizerCron.js — the GROUP BY can warm-cache in 30s
  // but cold runs against the partial index can push past the default.
  const client = await pool.connect();
  let hot;
  try {
    await client.query(`SET statement_timeout = 180000`);  // 3 min
    const r = await client.query(`
      SELECT k.keyword, SUM(k.total_count)::bigint AS mentions
      FROM keyword_daily_stats k
      WHERE k.date >= CURRENT_DATE - $1::int
        AND k.source_country_id IS NULL
        AND k.about_country_id IS NULL
        AND length(k.keyword) >= 3
        AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
      GROUP BY k.keyword
      HAVING SUM(k.total_count) >= $3::int
      ORDER BY SUM(k.total_count) DESC
      LIMIT $2
    `, [lookbackDays, overfetch, minFrequency]);
    hot = r.rows;
  } finally {
    client.release();
  }

  if (hot.length === 0) {
    return { scanned: 0, translated: 0, batches: 0, skippedAlreadyEn: 0, errors: 0 };
  }

  // Anti-join with keyword_translations using a single batched lookup.
  // ANY($1::text[]) hits the unique index `idx_kt_original` directly.
  const hotKeywords = hot.map(r => r.keyword);
  const { rows: existingTrans } = await pool.query(
    `SELECT original_keyword FROM keyword_translations WHERE original_keyword = ANY($1::text[])`,
    [hotKeywords]
  );
  const alreadyTranslated = new Set(existingTrans.map(r => r.original_keyword));
  const candidates = hot
    .filter(r => !alreadyTranslated.has(r.keyword))
    .slice(0, topN);

  // Filter to non-ASCII AND skip CJK/Thai/Khmer n-gram noise.
  //
  // The keyword extractor (keywordExtractor.js) handles space-less
  // scripts (zh, ja, ko, th, km, lo) by emitting character bigrams and
  // trigrams as proxy tokens. Those show up in keyword_daily_stats as
  // 2- or 3-character non-ASCII strings (e.g. "า", "่า", "្រ"). They
  // are NOT real keywords — DeepL either rejects them or returns
  // garbage that pollutes the index. Skip anything that's both
  //   - shorter than 4 chars, AND
  //   - consists entirely of non-ASCII chars with no internal space
  // so legitimate short multi-word phrases ("北京") that DO translate
  // cleanly still get through. We use a slightly different rule for
  // languages that genuinely produce short word forms (Cyrillic,
  // Arabic, Greek): keep them if length >= 3 — they're typically real
  // words, not n-gram fragments. Practically: filter is "short
  // contiguous CJK/Thai/Khmer/Lao only".
  const CJK_NOSPACE_NGRAM = /^[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u0E00-\u0E7F\u0E80-\u0EFF\u1780-\u17FF]{1,3}$/;
  const nonAscii = candidates.filter(c => {
    const k = c.keyword;
    if (!NON_ASCII.test(k)) return false;
    if (CJK_NOSPACE_NGRAM.test(k)) return false; // tokenizer artifact
    return true;
  });
  const skippedAlreadyEn = candidates.length - nonAscii.length;

  logger.log(`[kwi-translate] [${elapsed()}] candidates: ${candidates.length} total / ${nonAscii.length} non-ASCII (skipped ${skippedAlreadyEn} ASCII)`);

  if (nonAscii.length === 0) {
    return { scanned: 0, translated: 0, batches: 0, skippedAlreadyEn, errors: 0 };
  }

  if (dryRun) {
    logger.log(`[kwi-translate] DRY RUN — first 10 candidates:`);
    for (const c of nonAscii.slice(0, 10)) {
      logger.log(`  "${c.keyword}" (${c.mentions} mentions)`);
    }
    return { scanned: nonAscii.length, translated: 0, batches: 0, skippedAlreadyEn, errors: 0 };
  }

  const tr = getTranslator();
  let translated = 0;
  let batches = 0;
  let errors = 0;

  for (let i = 0; i < nonAscii.length; i += batchSize) {
    batches++;
    const batch = nonAscii.slice(i, i + batchSize);
    const texts = batch.map(c => c.keyword);

    let results;
    try {
      // DeepL Pro `translateText(string[], sourceLang, targetLang)` —
      // sourceLang null lets DeepL auto-detect per row, which is what
      // we want: a single batch can contain multiple source languages.
      results = await tr.translateText(texts, null, 'EN-US');
      if (!Array.isArray(results)) results = [results];
    } catch (err) {
      errors++;
      logger.warn(`[kwi-translate] batch ${batches} failed: ${err.message}`);
      continue;
    }

    // Build the bulk INSERT params. Each row carries the detected
    // source language (lowercased) so audits can later see which
    // languages the top-N pulls from.
    const writes = [];
    for (let j = 0; j < batch.length; j++) {
      const orig  = batch[j].keyword;
      const trans = (results[j]?.text || '').toLowerCase().trim();
      const lang  = normalizeLangCode(results[j]?.detectedSourceLang);
      if (!isUsableTranslation(orig, trans)) continue;
      writes.push([orig, trans, lang]);
    }
    if (!writes.length) continue;

    const vals = writes.map((_, k) => `($${k * 3 + 1}, $${k * 3 + 2}, $${k * 3 + 3})`).join(',');
    const params = writes.flatMap(w => w);
    try {
      await pool.query(
        `INSERT INTO keyword_translations
           (original_keyword, normalized_keyword, source_language)
         VALUES ${vals}
         ON CONFLICT (original_keyword) DO NOTHING`,
        params
      );
      translated += writes.length;
    } catch (err) {
      errors++;
      logger.warn(`[kwi-translate] batch ${batches} INSERT failed: ${err.message}`);
    }
  }

  logger.log(`[kwi-translate] [${elapsed()}] inserted ${translated} translations across ${batches} batch(es); ${errors} error(s)`);
  return { scanned: nonAscii.length, translated, batches, skippedAlreadyEn, errors };
}

module.exports = { translateTopKwiKeywords };

// CLI entrypoint — keeps the file directly invokable for one-off runs:
//   node keywordIntelligenceTranslator.js
//   node keywordIntelligenceTranslator.js --dry-run
//   node keywordIntelligenceTranslator.js --top=500
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const topArg = args.find(a => a.startsWith('--top='));
  const topN = topArg ? parseInt(topArg.split('=')[1], 10) : DEFAULTS.topN;

  translateTopKwiKeywords({ dryRun, topN })
    .then(async (r) => {
      console.log(`\nDone:`, r);
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Fatal:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
