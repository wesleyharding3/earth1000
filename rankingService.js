// rankingService.js
const pool = require("./db");
const { rankArticles } = require("./priorityEngine");

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

// How many hours back to look for candidates.
// Old articles can still appear if a caller passes an explicit offset
// large enough to exhaust recent ones — the fallback pool handles that.
const CANDIDATE_WINDOW_HOURS = 72;

// Hard cap on how many articles any single source can contribute to the
// ranked candidate set. Prevents a single outlet from flooding the feed
// when we no longer cap the overall pool size.
// At COOLDOWN_SLOTS=5, a source appears every 6 slots max — so 60 is generous.
const MAX_PER_SOURCE = 60;

// Ambient headline spotlight gate. When callers pass { ambient: true }, the
// candidate pool is restricted to tier 2/3/4 sources with a minimum
// base_priority. Rationale: tier 1 is wire-service dominated (AP/Reuters
// etc.) and tends to blanket the spotlight with the same handful of
// stories; tier 2-4 adds texture and regional voices. base_priority floor
// filters obvious junk (p90 ≈ 0.665 in prod; 2.0 is ~top ~1.5%, a strong
// "worth spotlighting" bar).
const AMBIENT_MIN_BASE_PRIORITY = 2.0;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function clampPositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ─────────────────────────────────────────────────────────────
// SHARED FIELDS
// Uses base_priority directly — classifyArticle already wrote the
// pre-computed score there. No GROUP BY, no article_tags JOIN,
// no non-determinism from aggregation order.
// ─────────────────────────────────────────────────────────────

const ARTICLE_FIELDS = `
  a.id,
  a.source_id,
  a.youtube_source_id,
  CASE
    WHEN a.youtube_source_id IS NOT NULL THEN 'youtube:' || a.youtube_source_id::text
    ELSE 'news:' || a.source_id::text
  END                                                        AS source_key,
  a.city_id,
  a.country_id,
  a.title,
  a.translated_title,
  a.url,
  a.article_url,
  a.summary,
  a.translated_summary,
  a.image_url,
  a.published_at,
  a.media_type,
  a.video_id,
  a.duration_seconds,
  a.language,
  COALESCE(ns.name,             ys.name)             AS source_name,
  COALESCE(ns.bias,             'unknown')           AS source_bias,
  COALESCE(ns.site_url,         ys.site_url)         AS site_url,
  COALESCE(ns.popularity_score, ys.popularity_score, 1.0) AS popularity_score,
  COALESCE(ns.popularity_tier,  ys.popularity_tier,  1)   AS popularity_tier,
  co.iso_code,
  -- base_priority is the pre-computed classification score from classifyArticle.
  -- Use it directly as intensity — no need to re-sum article_tags at query time.
  COALESCE(a.base_priority, 0)                             AS intensity,
  -- tagWeightSum is approximated from source priors already folded into
  -- base_priority. Pass 1.5 so computeTagMultiplier returns its mid value (1.10)
  -- rather than the minimum (1.00) for classified articles.
  CASE WHEN a.base_priority > 0 THEN 1.5 ELSE 0 END       AS "tagWeightSum"
`;

const ARTICLE_JOINS = `
  LEFT JOIN news_sources    ns ON ns.id = a.source_id
  LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
  LEFT JOIN countries       co ON co.id = a.country_id
`;

// ─────────────────────────────────────────────────────────────
// NATIONAL FEED
// ─────────────────────────────────────────────────────────────

async function getRankedArticles(countryId, options = {}) {
  const limit  = parseOptionalPositiveInt(options.limit);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;
  const ambient = !!options.ambient;

  const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
  const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";
  const ambientJoin = ambient ? `LEFT JOIN news_sources ns_amb ON ns_amb.id = a.source_id` : "";
  const ambientWhere = ambient
    ? `AND COALESCE(ns_amb.fetch_tier, 1) IN (2, 3, 4) AND COALESCE(a.base_priority, 0) >= ${AMBIENT_MIN_BASE_PRIORITY}`
    : "";

  const { rows } = await pool.query(`
    WITH ranked_by_source AS (
      SELECT a.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text)
          ORDER BY a.published_at DESC NULLS LAST, a.id DESC
        ) AS source_rank
      FROM news_articles a
      ${tagJoin}
      ${ambientJoin}
      WHERE a.country_id = $1
        AND a.city_id IS NULL
        AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
        ${tagWhere}
        ${ambientWhere}
    ),
    candidate_articles AS (
      SELECT id FROM ranked_by_source
      WHERE source_rank <= $2
      ORDER BY id DESC
    )
    SELECT ${ARTICLE_FIELDS}
    FROM candidate_articles ca
    JOIN news_articles a ON a.id = ca.id
    ${ARTICLE_JOINS}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
  `, [countryId, MAX_PER_SOURCE]);

  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity);
  return limit ? ranked.slice(offset, offset + limit) : ranked.slice(offset);
}

// ─────────────────────────────────────────────────────────────
// CITY FEED
// ─────────────────────────────────────────────────────────────

async function getRankedCityArticles(cityId, options = {}) {
  const limit  = parseOptionalPositiveInt(options.limit);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;
  const ambient = !!options.ambient;

  const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
  const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";
  const ambientJoin = ambient ? `LEFT JOIN news_sources ns_amb ON ns_amb.id = a.source_id` : "";
  const ambientWhere = ambient
    ? `AND COALESCE(ns_amb.fetch_tier, 1) IN (2, 3, 4) AND COALESCE(a.base_priority, 0) >= ${AMBIENT_MIN_BASE_PRIORITY}`
    : "";

  const { rows } = await pool.query(`
    WITH ranked_by_source AS (
      SELECT a.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text)
          ORDER BY a.published_at DESC NULLS LAST, a.id DESC
        ) AS source_rank
      FROM news_articles a
      ${tagJoin}
      ${ambientJoin}
      WHERE a.city_id = $1
        AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
        ${tagWhere}
        ${ambientWhere}
    ),
    candidate_articles AS (
      SELECT id FROM ranked_by_source
      WHERE source_rank <= $2
      ORDER BY id DESC
    )
    SELECT ${ARTICLE_FIELDS}
    FROM candidate_articles ca
    JOIN news_articles a ON a.id = ca.id
    ${ARTICLE_JOINS}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
  `, [cityId, MAX_PER_SOURCE]);

  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity, { skipCityPenalty: true });
  return limit ? ranked.slice(offset, offset + limit) : ranked.slice(offset);
}

module.exports = { getRankedArticles, getRankedCityArticles };
