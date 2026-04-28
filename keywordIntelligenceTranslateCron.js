// keywordIntelligenceTranslateCron.js
//
// Standalone cron entrypoint for the DeepL tactical KWI translator.
// Schedule daily on Render — narrow, cheap, idempotent.
//
// Distinct from keywordNormalizerCron.js (Claude Haiku, hourly,
// processes the long-tail at 5K keywords/run for storyThreadBuilder
// cross-language clustering). This cron is a smaller, KWI-surface-
// focused complement: it ensures the highest-mention keywords have a
// human-quality English translation in keyword_translations so the
// /api/keywords/trending and /rising endpoints can dedupe cleanly.
//
// At default scope (top 200 untranslated non-ASCII keywords / 7-day
// window) the cost is well under DeepL Pro's free monthly allowance
// even running every hour.

// Cap DB pool — this cron only needs one connection at a time.
process.env.DB_POOL_MAX = '2';

'use strict';

require('dotenv').config();

const pool = require('./db');
const { translateTopKwiKeywords } = require('./keywordIntelligenceTranslator');

const TOP_N = parseInt(process.env.KWI_TRANSLATE_TOP_N || '200', 10);

(async () => {
  const t0 = Date.now();
  console.log(`\n🌐 KWI Translator (DeepL tactical) — ${new Date().toISOString()}`);
  console.log(`   topN=${TOP_N}`);

  if (!process.env.DEEPL_API_KEY) {
    // Fail loud — same convention as keywordNormalizerCron's missing-key
    // refusal. Without DEEPL_API_KEY this script can't do its job and
    // silently exiting masks misconfigurations.
    console.error('DEEPL_API_KEY is not set — refusing to run.');
    await pool.end().catch(() => {});
    process.exit(1);
  }

  try {
    const result = await translateTopKwiKeywords({
      topN: TOP_N,
      logger: console,
    });
    console.log(`\n✅ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, result);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Fatal:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
