'use strict';

const deepl = require('deepl-node');

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_KEYWORD_LIMIT = 800;
const DEFAULT_CHAR_CAP = 80000;
const DEFAULT_MIN_ROWS = 2;
const DEFAULT_MIN_FREQUENCY = 3;

function isNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ''));
}

function sanitizeKeyword(value) {
  const keyword = String(value || '').trim().toLowerCase();
  if (!keyword || keyword.length < 2) return null;
  return keyword;
}

function normalizeTranslatedKeyword(translated, original) {
  const value = String(translated || '').trim().toLowerCase();
  if (!value) return null;

  const cleaned = value
    .replace(/^the\s+/i, '')
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const sanitized = sanitizeKeyword(cleaned);
  if (!sanitized) return null;

  const originalClean = String(original || '').trim().toLowerCase();
  if (sanitized === originalClean && !isNonAscii(originalClean)) return null;

  return sanitized;
}

async function normalizeRecentKeywords(options) {
  const {
    pool,
    anthropicClient = null,
    deeplApiKey = process.env.DEEPL_API_KEY || null,
    logger = console,
    batchSize = DEFAULT_BATCH_SIZE,
    keywordLimit = DEFAULT_KEYWORD_LIMIT,
    charCap = DEFAULT_CHAR_CAP,
    minRows = DEFAULT_MIN_ROWS,
    minFrequency = DEFAULT_MIN_FREQUENCY,
    scope,
    // Per-candidate-query statement_timeout (ms). Default 5min preserves the
    // legacy behaviour. Budgeted/chunked callers pass a tighter value (e.g.
    // 90_000) so a single heavy chunk can't eat the whole wall-clock budget.
    candidateTimeoutMs = 300_000,
    // DeepL fallback is DANGEROUS at production volume — keyword sets can
    // run ~100k DeepL chars/day. Fallback is now opt-in: callers must set
    // allowDeeplFallback:true to use DeepL when Claude is unavailable.
    // Default (false) means: if Claude is missing, skip the run entirely
    // rather than silently spend DeepL credits.
    allowDeeplFallback = false
  } = options || {};

  if (!pool) throw new Error('normalizeRecentKeywords requires pool');
  if (!scope || (!scope.hours && !(scope.threadIds && scope.windowStart && scope.windowEnd))) {
    throw new Error('normalizeRecentKeywords requires either scope.hours or scope.threadIds+windowStart+windowEnd');
  }

  // Provider preference: Claude Haiku FIRST when available. DeepL only
  // when the caller has explicitly opted into fallback via
  // allowDeeplFallback:true. Short keywords bill per-character on DeepL
  // and stack up fast (~576k chars/day measured when Claude was
  // erroneously demoted). Claude Haiku is dramatically cheaper at this
  // input size and returns JSON already in the shape we need.
  const translator = (allowDeeplFallback && deeplApiKey)
    ? new deepl.Translator(deeplApiKey, { serverUrl: 'https://api.deepl.com' })
    : null;
  const primaryProvider = anthropicClient ? 'claude' : (translator ? 'deepl' : 'none');
  if (!anthropicClient && !translator) {
    logger.warn?.('[keywordNormalizer] No Claude client and DeepL fallback is disabled — skipping run.');
  }

  const { sql, params } = buildCandidateQuery({
    scope,
    keywordLimit,
    minRows,
    minFrequency
  });

  // Two callers support:
  //   1. keywordNormalizerCron.js — passes a PRE-CONNECTED client with
  //      statement_timeout = 5min already set. We must NOT call
  //      pool.connect() on it (Client.connect throws "already connected").
  //   2. storyThreadBuilder.js — passes the real Pool. db.js enforces a
  //      45s per-client statement_timeout, which kills this aggregation.
  //      For the pool path we grab our own client + raise the timeout.
  //
  // Duck-type: a Pool exposes `.totalCount`, a PoolClient does not.
  const isPool = typeof pool.totalCount === 'number';
  let rows;
  if (isPool) {
    const candClient = await pool.connect();
    try {
      try { await candClient.query(`SET statement_timeout = ${candidateTimeoutMs}`); } catch (_) {}
      ({ rows } = await candClient.query(sql, params));
    } finally {
      candClient.release();
    }
  } else {
    // Already a client — cron already set the timeout. Use directly.
    ({ rows } = await pool.query(sql, params));
  }
  if (!rows.length) {
    return {
      provider: primaryProvider,
      candidateKeywords: 0,
      translatedChars: 0,
      updatedKeywords: 0,
      updatedRows: 0
    };
  }

  const pending = [];
  let translatedChars = 0;
  for (const row of rows) {
    const keyword = String(row.keyword || '').trim();
    if (!keyword) continue;
    const nextChars = translatedChars + keyword.length;
    if (nextChars > charCap) break;
    translatedChars = nextChars;
    pending.push({
      keyword,
      sourceLanguage: row.source_language || null,
      rowCount: Number(row.row_count) || 0
    });
  }

  if (!pending.length) {
    return {
      provider: primaryProvider,
      candidateKeywords: rows.length,
      translatedChars: 0,
      updatedKeywords: 0,
      updatedRows: 0
    };
  }

  let updatedKeywords = 0;
  let updatedRows = 0;

  // Primary path: Claude Haiku. Handles every pending keyword regardless
  // of script (Latin, CJK, Cyrillic, Arabic, …) — the SQL candidate
  // filter already narrowed to non-English-labelled or non-ASCII rows,
  // and the Claude prompt returns null for untranslatable fragments.
  if (anthropicClient) {
    logger.log?.(`   Claude normalizing ${pending.length} recent keywords...`);
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      try {
        const accepted = await normalizeBatchWithClaude(anthropicClient, batch.map((item) => item.keyword), logger);
        const stats = await persistTranslations(pool, accepted);
        updatedKeywords += stats.updatedKeywords;
        updatedRows += stats.updatedRows;
      } catch (err) {
        logger.warn?.(`[keywordNormalizer] Claude batch failed: ${err.message}`);
      }
    }

    return {
      provider: 'claude',
      candidateKeywords: rows.length,
      translatedChars,
      updatedKeywords,
      updatedRows
    };
  }

  // Fallback: DeepL (only reached when ANTHROPIC_API_KEY is unset).
  if (translator) {
    logger.log?.(`   DeepL normalizing ${pending.length} recent keywords (Claude unavailable)...`);
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const originals = batch.map((item) => item.keyword);

      try {
        const result = await translator.translateText(originals, null, 'EN-US');
        const translations = Array.isArray(result) ? result : [result];
        const accepted = [];

        for (let j = 0; j < batch.length; j++) {
          const original = batch[j].keyword;
          const translated = normalizeTranslatedKeyword(translations[j]?.text, original);
          if (!translated) continue;
          accepted.push({ original, translated });
        }

        const stats = await persistTranslations(pool, accepted);
        updatedKeywords += stats.updatedKeywords;
        updatedRows += stats.updatedRows;
      } catch (err) {
        logger.warn?.(`[keywordNormalizer] DeepL batch failed: ${err.message}`);
      }
    }

    return {
      provider: 'deepl',
      candidateKeywords: rows.length,
      translatedChars,
      updatedKeywords,
      updatedRows
    };
  }

  return {
    provider: 'none',
    candidateKeywords: rows.length,
    translatedChars: 0,
    updatedKeywords: 0,
    updatedRows: 0
  };
}

function buildCandidateQuery({ scope, keywordLimit, minRows, minFrequency }) {
  if (scope.hours) {
    // Restructured to be sargable on Render's heavy article_keywords
    // table:
    //   • Filter article_keywords by `source_language IS DISTINCT FROM 'en'`
    //     ONLY (no OR + regex). The original predicate had a non-sargable
    //     `keyword !~ '^[\x00-\x7F]+$'` that forced a sequential scan and
    //     timed out at 5min. Net effect: we miss the rare ASCII-only
    //     keyword tagged 'en' that's actually non-English (mojibake from
    //     bad scraping) — acceptable; those are < 0.1% of rows and
    //     usually wrong source_language tags anyway.
    //   • CTE-isolate the hot scan first so the planner doesn't try to
    //     join translations + run the having-clause sums in one pass.
    //   • Anti-join keyword_translations via NOT EXISTS *inside* the base
    //     CTE — earlier this filter ran AFTER the base scan, which meant
    //     the CTE materialized hundreds of thousands of rows that were
    //     about to be discarded. Pulling NOT EXISTS into base lets the
    //     planner hash-anti-join once and prune ~80%+ of rows before they
    //     reach the GROUP BY. This was the change that took the candidate
    //     query from "5-min timeout in prod" back under a minute.
    //
    // scope.skipHours (optional): exclude articles newer than skipHours ago.
    // Used by normalizeRecentKeywordsBudgeted to walk older windows after
    // newer ones are processed. When 0 (default), the upper bound becomes
    // `published_at < NOW()` which is a no-op.
    const skipHours = Number(scope.skipHours) || 0;
    return {
      sql: `
        WITH base AS (
          SELECT ak.keyword,
                 ak.source_language,
                 ak.frequency
            FROM article_keywords ak
            JOIN news_articles a ON a.id = ak.article_id
           WHERE a.published_at >= NOW() - (($1::int + $5::int) * INTERVAL '1 hour')
             AND a.published_at <  NOW() - ($5::int * INTERVAL '1 hour')
             AND ak.normalized_keyword IS NULL
             AND ak.keyword IS NOT NULL
             AND ak.source_language IS DISTINCT FROM 'en'
             AND LENGTH(ak.keyword) >= 3
             AND NOT EXISTS (
               SELECT 1 FROM keyword_translations kt
                WHERE kt.original_keyword = ak.keyword
             )
        )
        SELECT
          b.keyword,
          MIN(b.source_language) AS source_language,
          COUNT(*)::int          AS row_count,
          SUM(COALESCE(b.frequency, 1))::int AS total_frequency
          FROM base b
         GROUP BY b.keyword
        HAVING COUNT(*) >= $2
            OR SUM(COALESCE(b.frequency, 1)) >= $3
         ORDER BY SUM(COALESCE(b.frequency, 1)) DESC, COUNT(*) DESC, LENGTH(b.keyword) DESC
         LIMIT $4
      `,
      params: [scope.hours, minRows, minFrequency, keywordLimit, skipHours]
    };
  }

  return {
    sql: `
      SELECT
        ak.keyword,
        MIN(ak.source_language) AS source_language,
        COUNT(*)::int AS row_count,
        SUM(COALESCE(ak.frequency, 1))::int AS total_frequency
      FROM article_keywords ak
      JOIN story_thread_articles sta ON sta.article_id = ak.article_id
      JOIN news_articles a ON a.id = ak.article_id
      LEFT JOIN keyword_translations kt ON kt.original_keyword = ak.keyword
      WHERE sta.thread_id = ANY($1::int[])
        AND a.published_at >= $2
        AND a.published_at < $3
        AND ak.normalized_keyword IS NULL
        AND kt.original_keyword IS NULL
        AND ak.keyword IS NOT NULL
        AND LENGTH(TRIM(ak.keyword)) >= 3
        AND (
          ak.source_language IS DISTINCT FROM 'en'
          OR ak.keyword !~ '^[\\x00-\\x7F]+$'
        )
      GROUP BY ak.keyword
      HAVING COUNT(*) >= $4
         OR SUM(COALESCE(ak.frequency, 1)) >= $5
      ORDER BY SUM(COALESCE(ak.frequency, 1)) DESC, COUNT(*) DESC, LENGTH(ak.keyword) DESC
      LIMIT $6
    `,
    params: [
      scope.threadIds,
      scope.windowStart,
      scope.windowEnd,
      minRows,
      minFrequency,
      keywordLimit
    ]
  };
}

// Tolerant JSON extractor. Claude Haiku-4.5 regularly wraps its output
// in ```json ... ``` fences despite being told not to, which caused the
// previous `JSON.parse(trim(...))` to throw and the silent catch to drop
// the whole batch. That's why normalizer coverage was sitting at
// ~0% — every batch silently returned []. This strips fences, tries a
// whole-body parse, falls back to the first balanced-brace extraction,
// and loudly logs parse failures so cron logs surface them.
function _extractJsonObject(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  // Strip ```json … ``` fences (anchored). Truncated responses won't have
  // the closing fence; for those, also strip a leading ```json/``` so the
  // subsequent salvage path can still find the object body.
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }
  // Try whole-body parse first
  try { return JSON.parse(text); } catch (_) {}
  // Fallback: find the first { ... } block and parse that (greedy match
  // captures nested contents up to the last `}`).
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (_) {}
  }
  // Salvage path for TRUNCATED responses (no closing brace). Walks the
  // body tracking string state + brace depth, remembers the offset just
  // after the last complete top-level `"key": value` pair, then closes
  // the object there. Recovers ~95% of a cut-off batch instead of zero.
  if (text.startsWith('{')) {
    let depth = 0, inStr = false, esc = false, lastSafe = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === ',' && depth === 1) lastSafe = i;
    }
    if (lastSafe > 0) {
      const salvaged = text.slice(0, lastSafe) + '}';
      try { return JSON.parse(salvaged); } catch (_) {}
    }
  }
  return null;
}

async function normalizeBatchWithClaude(client, originals, logger = console) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    // 3500 was getting truncated mid-string for batches of 60 multilingual
    // keywords (esp. CJK + diacritics, where each char can take 2-3 tokens).
    // 6000 leaves headroom; the salvage path in _extractJsonObject still
    // catches anything that does cut off.
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: `Translate these news keywords/phrases to standard English equivalents for keyword indexing.
Return ONLY a valid JSON object: each key is the original keyword, each value is the lowercase English equivalent string, or null if untranslatable/too ambiguous.
Use standard English proper nouns (e.g. "Пекин"→"beijing", "北京"→"beijing", "موسكو"→"moscow", "한국"→"south korea").
Single characters or meaningless fragments → null.
Do NOT wrap the response in markdown code fences.

Keywords: ${JSON.stringify(originals)}

JSON only:`
    }]
  });

  const rawText = msg.content?.[0]?.text || '';
  const map = _extractJsonObject(rawText);
  if (!map) {
    // Loud: previously this was a silent return []. That's how coverage
    // collapsed to 0% without anyone noticing. Log the first 200 chars
    // of the raw body so we can diagnose drift in Claude's output format.
    logger.warn?.(`[keywordNormalizer] Claude JSON parse failed — dropping batch of ${originals.length}. Raw: ${rawText.slice(0, 200)}`);
    return [];
  }

  return Object.entries(map)
    .map(([original, translated]) => ({
      original,
      translated: normalizeTranslatedKeyword(translated, original)
    }))
    .filter((item) => item.translated);
}

async function persistTranslations(pool, accepted) {
  if (!accepted.length) return { updatedKeywords: 0, updatedRows: 0 };

  const insertValues = accepted.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(',');
  const insertParams = accepted.flatMap((item) => [item.original, item.translated]);
  await pool.query(
    `INSERT INTO keyword_translations (original_keyword, normalized_keyword)
     VALUES ${insertValues}
     ON CONFLICT (original_keyword)
     DO UPDATE SET normalized_keyword = EXCLUDED.normalized_keyword`,
    insertParams
  );

  let updatedRows = 0;
  for (const item of accepted) {
    const updateResult = await pool.query(
      `UPDATE article_keywords
       SET normalized_keyword = $1
       WHERE keyword = $2
         AND normalized_keyword IS NULL`,
      [item.translated, item.original]
    );
    updatedRows += updateResult.rowCount || 0;
  }

  return {
    updatedKeywords: accepted.length,
    updatedRows
  };
}

// Time-budgeted driver: walk backward from NOW in fixed-size chunks, calling
// normalizeRecentKeywords on each window with a tight per-chunk
// statement_timeout. Stops as soon as the wall-clock budget is exhausted (or
// maxLookbackHours is reached). Built for storyThreadBuilder's inline
// normalize step, which was timing out on a single 24h candidate query
// after the cron cadence shifted from 2h → 4h and the unnormalized backlog
// piled up. Each small chunk completes well under the candidate timeout, and
// however far back we get within the budget is what we get; the next run
// continues from wherever fresh articles have arrived.
async function normalizeRecentKeywordsBudgeted(options) {
  const {
    pool,
    anthropicClient = null,
    logger = console,
    budgetMs = 600_000,            // 10 min default total wall-clock budget
    chunkHours = 2,                // size of each lookback window
    maxLookbackHours = 168,        // 1 week safety stop
    candidateTimeoutMs = 90_000,   // per-chunk SQL statement_timeout
    keywordLimit,
    charCap,
    minRows,
    minFrequency,
    batchSize,
    deeplApiKey,
    allowDeeplFallback = false
  } = options || {};

  if (!pool) throw new Error('normalizeRecentKeywordsBudgeted requires pool');

  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  let totalCandidate = 0;
  let totalUpdatedKeywords = 0;
  let totalUpdatedRows = 0;
  let totalTranslatedChars = 0;
  let cursorHours = 0;
  let chunksRun = 0;
  let consecutiveErrors = 0;
  let budgetExhausted = false;

  while (cursorHours < maxLookbackHours) {
    if (elapsed() >= budgetMs) {
      budgetExhausted = true;
      break;
    }

    const windowSize = Math.min(chunkHours, maxLookbackHours - cursorHours);
    const chunkStart = cursorHours;
    const chunkEnd = cursorHours + windowSize;

    let chunkResult;
    try {
      chunkResult = await normalizeRecentKeywords({
        pool,
        anthropicClient,
        logger,
        candidateTimeoutMs,
        keywordLimit,
        charCap,
        minRows,
        minFrequency,
        batchSize,
        deeplApiKey,
        allowDeeplFallback,
        scope: { hours: windowSize, skipHours: chunkStart }
      });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.warn?.(`   ⚠ chunk ${chunkStart}-${chunkEnd}h failed: ${err.message}`);
      if (consecutiveErrors >= 2) {
        logger.warn?.(`   ⚠ Aborting budgeted run after ${consecutiveErrors} consecutive chunk errors`);
        break;
      }
      cursorHours = chunkEnd;
      continue;
    }

    totalCandidate += chunkResult.candidateKeywords || 0;
    totalUpdatedKeywords += chunkResult.updatedKeywords || 0;
    totalUpdatedRows += chunkResult.updatedRows || 0;
    totalTranslatedChars += chunkResult.translatedChars || 0;
    chunksRun++;
    cursorHours = chunkEnd;

    logger.log?.(`   chunk ${chunkStart}-${chunkEnd}h: cand=${chunkResult.candidateKeywords || 0} kw=${chunkResult.updatedKeywords || 0} rows=${chunkResult.updatedRows || 0} (elapsed ${(elapsed() / 1000).toFixed(1)}s)`);
  }

  return {
    provider: anthropicClient ? 'claude' : (allowDeeplFallback && (deeplApiKey || process.env.DEEPL_API_KEY) ? 'deepl' : 'none'),
    candidateKeywords: totalCandidate,
    translatedChars: totalTranslatedChars,
    updatedKeywords: totalUpdatedKeywords,
    updatedRows: totalUpdatedRows,
    chunksRun,
    furthestLookbackHours: cursorHours,
    elapsedMs: elapsed(),
    budgetExhausted
  };
}

module.exports = {
  normalizeRecentKeywords,
  normalizeRecentKeywordsBudgeted
};
