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

function computeKeywordOverlap(assetKeywords, articleKeywords) {
  if (!assetKeywords.length || !articleKeywords.length) return 0;
  const assetSet = new Set(assetKeywords);
  return articleKeywords.reduce((count, keyword) => count + (assetSet.has(keyword) ? 1 : 0), 0);
}

function scoreCandidate(candidate, context) {
  let score = 0;

  if (context.cityId && candidate.city_id === context.cityId) score += 40;
  if (context.countryId && candidate.country_id === context.countryId) score += 22;
  score += (candidate.tag_weight || 0) * 14;

  if (context.primaryCategories.includes(candidate.primary_category)) score += 10;
  if (context.genericCategories.includes(candidate.generic_category)) score += 6;

  const overlap = computeKeywordOverlap(candidate.keywords || [], context.keywords);
  score += overlap * 2.5;
  score += Math.max(candidate.priority || 0, 0);

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

async function findBestCandidate(context, client) {
  const defaultGenericCategories = ["general", "world", "global"];
  const primaryCategories = normalizeStringList(context.tags.map(tag => tag.name));
  const fallbackCategories = await fetchFallbackCategories(primaryCategories, client);
  const genericCategories = normalizeStringList([
    ...fallbackCategories,
    ...defaultGenericCategories,
  ]);
  const keywords = normalizeStringList(context.keywords);
  const tagIds = context.tags.map(tag => tag.id);

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
       COALESCE(MAX(CASE WHEN iat.tag_id = ANY($3::int[]) THEN iat.weight ELSE 0 END), 0) AS tag_weight
     FROM image_assets ia
     LEFT JOIN image_asset_tags iat ON iat.image_id = ia.id
     WHERE ia.is_active = TRUE
       AND (
         ($1::int IS NOT NULL AND ia.city_id = $1)
         OR ($2::int IS NOT NULL AND ia.country_id = $2)
         OR (COALESCE(array_length($3::int[], 1), 0) > 0 AND iat.tag_id = ANY($3::int[]))
         OR (COALESCE(array_length($4::text[], 1), 0) > 0 AND ia.keywords && $4::text[])
         OR (COALESCE(array_length($5::text[], 1), 0) > 0 AND ia.primary_category = ANY($5::text[]))
         OR (COALESCE(array_length($6::text[], 1), 0) > 0 AND ia.generic_category = ANY($6::text[]))
         OR ia.generic_category = ANY($7::text[])
       )
     GROUP BY ia.id
     ORDER BY ia.priority DESC, ia.usage_count ASC, ia.last_used_at ASC NULLS FIRST, ia.id ASC
     LIMIT 250`,
    [
      context.article.city_id,
      context.article.country_id,
      tagIds,
      keywords,
      primaryCategories,
      genericCategories,
      defaultGenericCategories,
    ]
  );

  if (!rows.length) return null;

  const scored = rows
    .map(candidate => scoreCandidate(candidate, {
      cityId: context.article.city_id,
      countryId: context.article.country_id,
      primaryCategories,
      genericCategories,
      keywords,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((a.usage_count || 0) !== (b.usage_count || 0)) return (a.usage_count || 0) - (b.usage_count || 0);
      const aLast = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bLast = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      if (aLast !== bLast) return aLast - bLast;
      return a.id - b.id;
    });

  return scored[0];
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
      "location-tag-keyword",
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
        matchStrategy: "location-tag-keyword",
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
  const client = options.client || await pool.connect();
  const ownsClient = !options.client;

  try {
    if (ownsClient) await client.query("BEGIN");

    const context = await fetchArticleContext(articleId, client);
    if (!context) {
      if (ownsClient) await client.query("COMMIT");
      return null;
    }

    if (context.article.image_url) {
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
