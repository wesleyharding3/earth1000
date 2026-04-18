const pool = require("./db");

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeStringList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeText)
      .filter(Boolean)
  )];
}

// Exact-phrase match only. Previously we token-split multi-word asset keywords
// (e.g. "ejection seat" → ["ejection","seat"]) which caused dumb collisions —
// any article mentioning "seat" would match an "ejection seat" asset. Dropped
// because the false-positive rate swamped the recall gain.
function computeKeywordOverlap(assetKeywords, articleKeywords) {
  if (!assetKeywords.length || !articleKeywords.length) return 0;
  const assetSet = new Set(assetKeywords.filter(Boolean).map(k => k.toLowerCase()));
  return articleKeywords.reduce(
    (count, keyword) => count + (assetSet.has(String(keyword).toLowerCase()) ? 1 : 0),
    0
  );
}

// ─── Scoring weights ────────────────────────────────────────────────────────
// Content match dominates. Previous weights (country +22, tag_weight × 14,
// keyword × 2.5, generic_category +6) let generic-category images win over
// thematically correct but slightly less-decorated ones — the reason
// "Buddhist temple on Australian mine" could happen. Rebalanced so:
//   • location match (city/country) is strongest
//   • content tags are the primary relevance signal
//   • keyword overlap reinforces
//   • generic_category is a weak nudge, not a carrying signal
const W_CITY_MATCH            = 40;
const W_COUNTRY_MATCH         = 40;   // was 22 — content-less country match should carry
const W_COUNTRY_MISMATCH      = -50;
const W_TAG_WEIGHT            = 30;   // was 14 — tags are the strongest content signal
const W_PRIMARY_CATEGORY      = 20;   // was 10 — exact category is meaningful
const W_GENERIC_CATEGORY      = 2;    // was 6 — too weak to drive assignment on its own
const W_KEYWORD_OVERLAP_EACH  = 6;    // was 2.5 — per matched keyword
const W_THEMATIC_MISMATCH     = -15;  // article has tags, candidate has zero overlap
const W_REUSE_PENALTY_PER_USE = 0.5;  // small score haircut — NOT a sort key
const REUSE_PENALTY_CAP       = 5;    // never pushes a correct reuse below a wrong fresh image

// Minimum score for assignment. Below this, return null — no image is better
// than a wrong image. Tune up to be pickier, down for more coverage.
const MIN_ASSIGN_SCORE = 15;

function scoreCandidate(candidate, context) {
  let score = 0;

  if (context.cityId && candidate.city_id === context.cityId) score += W_CITY_MATCH;
  if (context.countryId && candidate.country_id === context.countryId) score += W_COUNTRY_MATCH;

  // Country-mismatch hard penalty: belt-and-suspenders behind the Tier 3 SQL
  // gate. Catches anything that slips through on Tier 1/2 overflow.
  if (
    context.countryId &&
    candidate.country_id &&
    candidate.country_id !== context.countryId
  ) {
    score += W_COUNTRY_MISMATCH;
  }

  const tagWeight = candidate.tag_weight || 0;
  score += tagWeight * W_TAG_WEIGHT;

  // Thematic-mismatch penalty: when the article has tags but the candidate
  // has zero tag overlap AND no category/keyword match, it's almost certainly
  // thematically wrong. Penalize so it loses to even a reused correct image.
  const overlap = computeKeywordOverlap(candidate.keywords || [], context.keywords);
  const hasPrimaryMatch  = context.primaryCategories.includes(candidate.primary_category);
  const hasGenericMatch  = context.genericCategories.includes(candidate.generic_category);
  const hasAnyContentSignal = tagWeight > 0 || overlap > 0 || hasPrimaryMatch;
  if (context.tagIds && context.tagIds.length > 0 && !hasAnyContentSignal) {
    score += W_THEMATIC_MISMATCH;
  }

  if (hasPrimaryMatch) score += W_PRIMARY_CATEGORY;
  if (hasGenericMatch) score += W_GENERIC_CATEGORY;

  score += overlap * W_KEYWORD_OVERLAP_EACH;
  score += Math.max(candidate.priority || 0, 0);

  // Soft reuse penalty: -0.5 per prior use, capped at -5. Replaces the old
  // `usage_count ASC` sort tiebreak that forced us to pick unused-but-wrong
  // images over used-but-correct ones. Correctness wins; freshness is a
  // secondary preference rather than a hard rule.
  const uses = candidate.usage_count || 0;
  const reusePenalty = Math.min(uses, REUSE_PENALTY_CAP / W_REUSE_PENALTY_PER_USE) * W_REUSE_PENALTY_PER_USE;
  score -= reusePenalty;

  return {
    ...candidate,
    keyword_overlap: overlap,
    score,
  };
}

async function fetchArticleContext(articleId, client) {
  const articleRes = await client.query(
    `SELECT
       a.id,
       a.image_url,
       a.city_id,
       a.country_id,
       COALESCE(a.translated_title, a.title) AS title,
       COALESCE(a.translated_summary, a.summary) AS summary
     FROM news_articles a
     WHERE a.id = $1
     LIMIT 1`,
    [articleId]
  );

  const article = articleRes.rows[0];
  if (!article) return null;

  const [assignmentRes, tagsRes, keywordsRes] = await Promise.all([
    client.query(
      `SELECT
         aia.image_id,
         aia.match_strategy,
         aia.matched_tag_id,
         aia.matched_keyword,
         aia.matched_category,
         aia.confidence,
         ia.public_url,
         ia.is_active
       FROM article_image_assignments aia
       JOIN image_assets ia ON ia.id = aia.image_id
       WHERE aia.article_id = $1
       LIMIT 1`,
      [articleId]
    ),
    client.query(
      `SELECT
         t.id,
         LOWER(t.name) AS name,
         at.score
       FROM article_tags at
       JOIN tags t ON t.id = at.tag_id
       WHERE at.article_id = $1
       ORDER BY at.rank ASC, at.score DESC
       LIMIT 5`,
      [articleId]
    ),
    client.query(
      `SELECT
         LOWER(keyword) AS keyword,
         frequency
       FROM article_keywords
       WHERE article_id = $1
       ORDER BY frequency DESC, keyword ASC
       LIMIT 12`,
      [articleId]
    ),
  ]);

  return {
    article,
    existingAssignment: assignmentRes.rows[0] || null,
    tags: tagsRes.rows,
    keywords: keywordsRes.rows.map(row => row.keyword),
  };
}

async function fetchFallbackCategories(primaryCategories, client) {
  const categories = normalizeStringList(primaryCategories);
  if (!categories.length) return [];

  const { rows } = await client.query(
    `SELECT fallback_category
     FROM image_category_fallbacks
     WHERE category = ANY($1::text[])
     ORDER BY priority ASC, fallback_category ASC`,
    [categories]
  );

  return normalizeStringList(rows.map(row => row.fallback_category));
}

// ─── Saturation check ─────────────────────────────────────────────────────────
// A location pool is "saturated" when all its images have been used recently
// enough that showing them again would look redundant.
//
// Saturation threshold: if the least-used image in the pool has been used
// more than (SATURATION_MULTIPLIER × pool_size) times total, the pool is
// considered exhausted and we overflow to the next level.
//
// Example: 10 Cartagena images, multiplier 3 → saturated after ~30 combined uses.
// At that point overflow to Colombia images, then to tag/generic.
const SATURATION_MULTIPLIER = 3;
const SATURATION_WINDOW_HOURS = 24;

// In-process saturation cache — keyed by "city:ID" or "country:ID".
// Avoids re-querying the DB for every article during bulk operations.
// TTL of 60 seconds: fresh enough for live use, cheap enough for backfill.
const _satCache = new Map();
const SAT_CACHE_TTL_MS = 60_000;

function _satCacheKey(type, id) { return `${type}:${id}`; }

async function getPoolSaturation(locationClause, params, client, cacheKey) {
  if (cacheKey) {
    const cached = _satCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SAT_CACHE_TTL_MS) {
      return cached.value;
    }
  }
  const { rows } = await client.query(
    `SELECT
       COUNT(*)                                    AS pool_size,
       MIN(ia.usage_count)                         AS min_usage,
       COUNT(*) FILTER (
         WHERE ia.last_used_at > NOW() - INTERVAL '${SATURATION_WINDOW_HOURS} hours'
       )                                           AS used_recently
     FROM image_assets ia
     WHERE ia.is_active = TRUE
       AND ${locationClause}`,
    params
  );
  const row = rows[0];
  const poolSize    = parseInt(row.pool_size) || 0;
  const minUsage    = parseInt(row.min_usage) || 0;
  const usedRecently = parseInt(row.used_recently) || 0;

  if (poolSize === 0) return { saturated: true, poolSize: 0, reason: "empty" };

  // Saturated if: all images used recently AND min usage exceeds threshold
  const threshold = poolSize * SATURATION_MULTIPLIER;
  const saturated = usedRecently >= poolSize && minUsage >= threshold;

  const result = { saturated, poolSize, minUsage, usedRecently, threshold };
  if (cacheKey) _satCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

// ─── Tiered pool query ─────────────────────────────────────────────────────────
// Queries a specific pool (city, country, or tag/generic) and scores results.
async function queryPool(poolWhere, poolParams, scoringContext, tagIds, client) {
  const { rows } = await client.query(
    `SELECT
       ia.id,
       ia.public_url,
       ia.city_id,
       ia.country_id,
       ia.primary_category,
       ia.generic_category,
       ia.keywords,
       ia.priority,
       ia.usage_count,
       ia.last_used_at,
       COALESCE(MAX(CASE WHEN iat.tag_id = ANY($1::int[]) THEN iat.weight ELSE 0 END), 0) AS tag_weight
     FROM image_assets ia
     LEFT JOIN image_asset_tags iat ON iat.image_id = ia.id
     WHERE ia.is_active = TRUE
       AND (${poolWhere})
     GROUP BY ia.id
     ORDER BY ia.priority DESC,
              ia.usage_count ASC,
              ia.last_used_at ASC NULLS FIRST,
              RANDOM()
     LIMIT 250`,
    [tagIds, ...poolParams]
  );
  return rows;
}

async function findBestCandidate(context, client) {
  // NOTE: the old default fallback list ["general","world","global"] used to
  // be OR'd into the Tier 3 SQL gate, which meant any image with
  // generic_category='general' was eligible for any article — producing
  // "Buddhist temple on Australian mine" failures when content-specific
  // images weren't available. Removed. Generic categories now only flow
  // through when the article's own tags map to them via
  // image_category_fallbacks (the `fallbackCategories` source).
  const primaryCategories = normalizeStringList(context.tags.map(tag => tag.name));
  const fallbackCategories = await fetchFallbackCategories(primaryCategories, client);
  const genericCategories = normalizeStringList(fallbackCategories);
  const keywords = normalizeStringList(context.keywords);
  const tagIds   = context.tags.map(tag => tag.id);

  const cityId    = context.article.city_id;
  const countryId = context.article.country_id;

  // ── Tier 1: city pool ────────────────────────────────────────
  //
  // Saturation check DISABLED by design: we'd rather repeat a correct
  // city/country image than overflow to a cross-country generic match
  // (e.g. Iranian mosque on a Brazil article). Repeats beat wrong.
  // The only skip condition is poolSize === 0.
  let usedTier = "generic";
  let poolRows  = [];

  if (cityId) {
    poolRows = await queryPool(`ia.city_id = $2`, [cityId], {}, tagIds, client);
    if (poolRows.length) usedTier = "city";
  }

  // ── Tier 2: country pool (if no city or city pool empty) ─────
  if (!poolRows.length && countryId) {
    poolRows = await queryPool(
      `ia.country_id = $2 AND ia.city_id IS NULL`, [countryId], {}, tagIds, client
    );
    if (poolRows.length) usedTier = "country";
  }

  // ── Tier 3: tag/keyword/category (final fallback) ─────────────
  //
  // Hard country-gate: when the article has a country_id, any candidate
  // whose country_id is non-null MUST match. Location-agnostic assets
  // (country_id IS NULL) are still eligible. This SQL filter is the
  // first line of defense; scoreCandidate adds a -50 penalty as backup.
  //
  // The old "generic_category IN ('general','world','global')" OR-branch
  // was removed — it was the gate that let Buddhist temples into Australian
  // mine articles. Now a candidate must match at least one of: tag / keyword /
  // primary_category / mapped-fallback generic_category. Nothing gets in on
  // "general" alone.
  if (!poolRows.length) {
    const { rows } = await client.query(
      `SELECT
         ia.id, ia.public_url, ia.city_id, ia.country_id,
         ia.primary_category, ia.generic_category,
         ia.keywords, ia.priority, ia.usage_count, ia.last_used_at,
         COALESCE(MAX(CASE WHEN iat.tag_id = ANY($1::int[]) THEN iat.weight ELSE 0 END), 0) AS tag_weight
       FROM image_assets ia
       LEFT JOIN image_asset_tags iat ON iat.image_id = ia.id
       WHERE ia.is_active = TRUE
         AND (
           $5::int IS NULL
           OR ia.country_id IS NULL
           OR ia.country_id = $5::int
         )
         AND (
           (COALESCE(array_length($1::int[], 1), 0) > 0 AND iat.tag_id = ANY($1::int[]))
           OR (COALESCE(array_length($2::text[], 1), 0) > 0 AND ia.keywords && $2::text[])
           OR (COALESCE(array_length($3::text[], 1), 0) > 0 AND ia.primary_category = ANY($3::text[]))
           OR (COALESCE(array_length($4::text[], 1), 0) > 0 AND ia.generic_category = ANY($4::text[]))
         )
       GROUP BY ia.id
       ORDER BY ia.priority DESC, ia.usage_count ASC, ia.last_used_at ASC NULLS FIRST, RANDOM()
       LIMIT 250`,
      [tagIds, keywords, primaryCategories, genericCategories, countryId || null]
    );
    poolRows = rows;
    usedTier = "generic";
  }

  if (!poolRows.length) return null;

  // ── Score the winning pool ────────────────────────────────────
  // usage_count is baked into score via the soft reuse penalty in
  // scoreCandidate — it's no longer a hard tiebreaker here. last_used_at
  // remains as a secondary tiebreak: when scores are truly equal, prefer
  // the image that's been idle longer.
  const scored = poolRows
    .map(candidate => scoreCandidate(candidate, {
      cityId,
      countryId,
      primaryCategories,
      genericCategories,
      keywords,
      tagIds,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aLast = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bLast = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      return aLast - bLast;
    });

  const best = scored[0];

  // Minimum-score floor: below this threshold we've failed to find a
  // thematically relevant image. Better to return null and let the UI
  // render an image-less card than pin something unrelated. If you're
  // seeing too many image-less cards after deploy, lower MIN_ASSIGN_SCORE
  // (module constant above) — don't hack around it here.
  if (!best || best.score < MIN_ASSIGN_SCORE) return null;

  return { ...best, _tier: usedTier };

}

async function persistAssignment(articleId, candidate, context, surface, client) {
  const matchedTagId = context.tags[0]?.id || null;
  const matchedKeyword = context.keywords[0] || null;
  const matchedCategory =
    candidate.primary_category ||
    candidate.generic_category ||
    context.tags[0]?.name ||
    null;

  await client.query(
    `INSERT INTO article_image_assignments (
       article_id,
       image_id,
       source_type,
       match_strategy,
       matched_tag_id,
       matched_keyword,
       matched_category,
       confidence,
       assigned_at,
       refreshed_at
     )
     VALUES ($1, $2, 'fallback', $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (article_id) DO UPDATE
     SET image_id = EXCLUDED.image_id,
         source_type = EXCLUDED.source_type,
         match_strategy = EXCLUDED.match_strategy,
         matched_tag_id = EXCLUDED.matched_tag_id,
         matched_keyword = EXCLUDED.matched_keyword,
         matched_category = EXCLUDED.matched_category,
         confidence = EXCLUDED.confidence,
         refreshed_at = NOW()`,
    [
      articleId,
      candidate.id,
      `${candidate._tier || "generic"}-overflow`,
      matchedTagId,
      matchedKeyword,
      matchedCategory,
      candidate.score,
    ]
  );

  await client.query(
    `UPDATE image_assets
     SET usage_count = usage_count + 1,
         last_used_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [candidate.id]
  );

  await client.query(
    `INSERT INTO image_usage_log (article_id, image_id, surface, context)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      articleId,
      candidate.id,
      surface,
      JSON.stringify({
        matchStrategy: `${candidate._tier || "generic"}-overflow`,
        matchedTagId,
        matchedKeyword,
        matchedCategory,
        score: candidate.score,
      }),
    ]
  );
}

async function resolveImageForArticle(articleId, options = {}) {
  const surface = options.surface || "feed";
  const forceAssign = options.forceAssign || false;
  const client = options.client || await pool.connect();
  const ownsClient = !options.client;

  try {
    if (ownsClient) await client.query("BEGIN");

    const context = await fetchArticleContext(articleId, client);
    if (!context) {
      if (ownsClient) await client.query("COMMIT");
      return null;
    }

    if (context.article.image_url && !forceAssign) {
      if (ownsClient) await client.query("COMMIT");
      return {
        articleId,
        imageUrl: context.article.image_url,
        source: "article",
      };
    }

    if (context.existingAssignment?.public_url && context.existingAssignment?.is_active) {
      await client.query(
        `INSERT INTO image_usage_log (article_id, image_id, surface, context)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          articleId,
          context.existingAssignment.image_id,
          surface,
          JSON.stringify({
            source: "existing-assignment",
            matchStrategy: context.existingAssignment.match_strategy,
            matchedTagId: context.existingAssignment.matched_tag_id,
            matchedKeyword: context.existingAssignment.matched_keyword,
            matchedCategory: context.existingAssignment.matched_category,
            confidence: context.existingAssignment.confidence,
          }),
        ]
      );

      if (ownsClient) await client.query("COMMIT");
      return {
        articleId,
        imageUrl: context.existingAssignment.public_url,
        source: "assignment",
      };
    }

    const candidate = await findBestCandidate(context, client);
    if (!candidate) {
      if (ownsClient) await client.query("COMMIT");
      return {
        articleId,
        imageUrl: null,
        source: "none",
      };
    }

    await persistAssignment(articleId, candidate, context, surface, client);

    if (ownsClient) await client.query("COMMIT");
    return {
      articleId,
      imageUrl: candidate.public_url,
      source: "fallback",
      imageId: candidate.id,
      score: candidate.score,
    };
  } catch (err) {
    if (ownsClient) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

async function resolveImagesForArticles(articleIds, options = {}) {
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : [])
    .map(id => parseInt(id, 10))
    .filter(Number.isFinite))];

  if (!ids.length) return [];

  const surface = options.surface || "feed";
  const results = [];

  for (const articleId of ids) {
    const resolved = await resolveImageForArticle(articleId, { surface });
    if (resolved) results.push(resolved);
  }

  return results;
}

module.exports = {
  resolveImageForArticle,
  resolveImagesForArticles,
};