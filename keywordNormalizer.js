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

  const { rows } = await pool.query(sql, params);
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
    for (let i = 0; i < pending.length; i += 60) {
      const batch = pending.slice(i, i + 60);
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
    return {
      sql: `
        SELECT
          ak.keyword,
          MIN(ak.source_language) AS source_language,
          COUNT(*)::int AS row_count,
          SUM(COALESCE(ak.frequency, 1))::int AS total_frequency
        FROM article_keywords ak
        JOIN news_articles a ON a.id = ak.article_id
        LEFT JOIN keyword_translations kt ON kt.original_keyword = ak.keyword
        WHERE a.published_at >= NOW() - ($1 * INTERVAL '1 hour')
          AND ak.normalized_keyword IS NULL
          AND kt.original_keyword IS NULL
          AND ak.keyword IS NOT NULL
          AND LENGTH(TRIM(ak.keyword)) >= 3
          AND (
            ak.source_language IS DISTINCT FROM 'en'
            OR ak.keyword !~ '^[\\x00-\\x7F]+$'
          )
        GROUP BY ak.keyword
        HAVING COUNT(*) >= $2
           OR SUM(COALESCE(ak.frequency, 1)) >= $3
        ORDER BY SUM(COALESCE(ak.frequency, 1)) DESC, COUNT(*) DESC, LENGTH(ak.keyword) DESC
        LIMIT $4
      `,
      params: [scope.hours, minRows, minFrequency, keywordLimit]
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
  // Strip ```json or ``` fences if present
  let text = String(rawText).trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Try whole-body parse first
  try { return JSON.parse(text); } catch (_) {}
  // Fallback: find the first { ... } block and parse that
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (_) {}
  }
  return null;
}

async function normalizeBatchWithClaude(client, originals, logger = console) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
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

module.exports = {
  normalizeRecentKeywords
};
