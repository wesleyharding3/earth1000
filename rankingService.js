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

// Candidate pool: enough to give diversityRerank room to work, but not
// so large that we're sorting thousands of rows on every request.
const CANDIDATE_POOL = 400;

// Hard cap on how many articles any single source can contribute to the
// candidate pool. Prevents NBC/BBC/Reuters from flooding 350 of 400 slots
// and making diversityRerank's job impossible.
// At COOLDOWN_SLOTS=5, a source appears every 6 slots max — so 60 is generous.
const MAX_PER_SOURCE = 60;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function clampPositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const limit  = clampPositiveInt(options.limit, 50);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;

  const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
  const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";

  const { rows } = await pool.query(`
    WITH ranked_by_source AS (
      SELECT a.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text)
          ORDER BY a.published_at DESC NULLS LAST, a.id DESC
        ) AS source_rank
      FROM news_articles a
      ${tagJoin}
      WHERE a.country_id = $1
        AND a.city_id IS NULL
        AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
        ${tagWhere}
    ),
    candidate_articles AS (
      SELECT id FROM ranked_by_source
      WHERE source_rank <= $3
      ORDER BY id DESC
      LIMIT $2
    )
    SELECT ${ARTICLE_FIELDS}
    FROM candidate_articles ca
    JOIN news_articles a ON a.id = ca.id
    ${ARTICLE_JOINS}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
  `, [countryId, CANDIDATE_POOL, MAX_PER_SOURCE]);

  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity);
  return ranked.slice(offset, offset + limit);
}

// ─────────────────────────────────────────────────────────────
// CITY FEED
// ─────────────────────────────────────────────────────────────

async function getRankedCityArticles(cityId, options = {}) {
  const limit  = clampPositiveInt(options.limit, 50);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;

  const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
  const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";

  const { rows } = await pool.query(`
    WITH ranked_by_source AS (
      SELECT a.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text)
          ORDER BY a.published_at DESC NULLS LAST, a.id DESC
        ) AS source_rank
      FROM news_articles a
      ${tagJoin}
      WHERE a.city_id = $1
        AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
        ${tagWhere}
    ),
    candidate_articles AS (
      SELECT id FROM ranked_by_source
      WHERE source_rank <= $3
      ORDER BY id DESC
      LIMIT $2
    )
    SELECT ${ARTICLE_FIELDS}
    FROM candidate_articles ca
    JOIN news_articles a ON a.id = ca.id
    ${ARTICLE_JOINS}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
  `, [cityId, CANDIDATE_POOL, MAX_PER_SOURCE]);

  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity, { skipCityPenalty: true });
  return ranked.slice(offset, offset + limit);
}

module.exports = { getRankedArticles, getRankedCityArticles };
