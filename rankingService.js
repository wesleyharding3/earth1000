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

// Bound the candidate pool pushed into JS rank. Replaces the old ROW_NUMBER()
// window function that sorted the full 72h × all-sources candidate set just
// to cap per-source. Pulling the freshest ~800 rows and capping per-source in
// JS is equivalent on any realistic feed, and lets Postgres do a single index
// range scan on (country_id, published_at DESC) instead of a big sort.
const NATIONAL_POOL_LIMIT = 800;
const CITY_POOL_LIMIT     = 400;

// Statement timeouts for the tiered fallback. Tier 1 is the full query with
// the LATERAL thread lookup; Tier 2 drops the thread lookup so articles still
// render even when the thread-status join is the cold-buffer bottleneck.
// The pool's default statement_timeout is 45s — we shorten these so a single
// cold request can't burn a connection for the full 45s window.
const TIER1_TIMEOUT_MS = 12000;
const TIER2_TIMEOUT_MS = 4000;
const POOL_DEFAULT_TIMEOUT_MS = 45000;

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
  CASE
    WHEN a.youtube_source_id IS NOT NULL THEN GREATEST(COALESCE(ys.popularity_score, 1.0), 1.25)
    ELSE COALESCE(ns.popularity_score, ys.popularity_score, 1.0)
  END AS popularity_score,
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
// QUERY BUILDER + TIERED EXECUTOR
// ─────────────────────────────────────────────────────────────
//
// Fetches up to `poolLimit` articles matching the scope (country/city filter)
// ordered by published_at DESC. Thread status (`in_thread`, `thread_status`)
// is consolidated into a single LATERAL lookup — previously we issued two
// separate correlated subqueries against story_thread_articles for every row,
// which on cold buffer cache tipped the whole feed query past our pool's
// 45s statement_timeout and returned 500s to the client.
//
// Two-tier execution with statement timeouts:
//   Tier 1 (12s): full query incl. thread LATERAL + source/country joins.
//   Tier 2 ( 4s): drops the thread LATERAL entirely. Articles lose the
//                 in-thread boost in JS ranking, but the feed still renders.
//
// This mirrors the approach used by /api/news/search's _executeNewsSearch.

function _buildAmbientClauses(ambient) {
  // Inner-join on news_sources is equivalent to the prior
  //   LEFT JOIN news_sources + COALESCE(fetch_tier, 1) IN (2,3,4)
  // because COALESCE(NULL,1) IN (2,3,4) is always false — both forms exclude
  // YouTube-only articles and articles without a news_sources row. INNER JOIN
  // lets the planner push the filter into the join instead of evaluating a
  // COALESCE(...) predicate that blocks index use on fetch_tier.
  return {
    join: ambient
      ? `JOIN news_sources ns_amb ON ns_amb.id = a.source_id AND ns_amb.fetch_tier IN (2, 3, 4)`
      : "",
    // Dropping COALESCE so the planner can consider any btree index on
    // base_priority; a NULL base_priority is filtered by this predicate the
    // same as COALESCE(base_priority, 0) >= 2.0 would (NULL >= 2.0 is NULL).
    where: ambient ? `AND a.base_priority >= ${AMBIENT_MIN_BASE_PRIORITY}` : "",
  };
}

function _buildTagClause(tagId) {
  return tagId
    ? `JOIN article_tags at ON at.article_id = a.id AND at.tag_id = ${parseInt(tagId, 10)}`
    : "";
}

async function _runWithTimeout(sql, params, timeoutMs) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    // Restore the pool's default so the next consumer of this physical
    // connection isn't stuck with our short timeout.
    await client.query(`SET statement_timeout = ${POOL_DEFAULT_TIMEOUT_MS}`).catch(() => {});
    client.release();
  }
}

async function _loadCandidatePool({ scopeSql, scopeParams, ambient, tagId, poolLimit }) {
  const { join: ambientJoin, where: ambientWhere } = _buildAmbientClauses(ambient);
  const tagJoin = _buildTagClause(tagId);

  // ── Tier 1: full query, thread lookup via single LATERAL ────────────
  const tier1 = `
    SELECT ${ARTICLE_FIELDS},
      COALESCE(th.in_thread, false) AS in_thread,
      th.thread_status
    FROM news_articles a
    ${ARTICLE_JOINS}
    ${ambientJoin}
    ${tagJoin}
    LEFT JOIN LATERAL (
      SELECT true AS in_thread,
        CASE
          WHEN bool_or(t.status = 'active')  THEN 'active'
          WHEN bool_or(t.status = 'cooling') THEN 'cooling'
          WHEN bool_or(t.status = 'dormant') THEN 'dormant'
          ELSE NULL
        END AS thread_status
      FROM story_thread_articles sta
      JOIN story_threads t ON t.id = sta.thread_id
      WHERE sta.article_id = a.id
    ) th ON TRUE
    WHERE ${scopeSql}
      AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
      ${ambientWhere}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
    LIMIT ${poolLimit}
  `;

  try {
    return await _runWithTimeout(tier1, scopeParams, TIER1_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[rankingService] tier1 timed out (${TIER1_TIMEOUT_MS}ms): ${err.message}, falling back to tier2`);
  }

  // ── Tier 2: drop thread lookup entirely ─────────────────────────────
  // Feed still renders; articles just won't get the in-thread boost from
  // priorityEngine. Acceptable degradation vs. 500ing the whole request.
  const tier2 = `
    SELECT ${ARTICLE_FIELDS},
      false AS in_thread,
      NULL::text AS thread_status
    FROM news_articles a
    ${ARTICLE_JOINS}
    ${ambientJoin}
    ${tagJoin}
    WHERE ${scopeSql}
      AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
      ${ambientWhere}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
    LIMIT ${poolLimit}
  `;

  try {
    return await _runWithTimeout(tier2, scopeParams, TIER2_TIMEOUT_MS);
  } catch (err2) {
    console.warn(`[rankingService] tier2 timed out (${TIER2_TIMEOUT_MS}ms): ${err2.message}, returning empty`);
    return [];
  }
}

function _applyPerSourceCap(rows, maxPerSource) {
  const perSource = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.source_key
      || (r.source_id != null ? `news:${r.source_id}` : `yt:${r.youtube_source_id}`);
    const n = perSource.get(key) || 0;
    if (n >= maxPerSource) continue;
    perSource.set(key, n + 1);
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// NATIONAL FEED
// ─────────────────────────────────────────────────────────────

async function getRankedArticles(countryId, options = {}) {
  const limit  = parseOptionalPositiveInt(options.limit);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;
  const ambient = !!options.ambient;

  const prelim = await _loadCandidatePool({
    scopeSql: `a.country_id = $1 AND a.city_id IS NULL`,
    scopeParams: [countryId],
    ambient,
    tagId,
    poolLimit: NATIONAL_POOL_LIMIT,
  });

  const rows = _applyPerSourceCap(prelim, MAX_PER_SOURCE);
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

  const prelim = await _loadCandidatePool({
    scopeSql: `a.city_id = $1`,
    scopeParams: [cityId],
    ambient,
    tagId,
    poolLimit: CITY_POOL_LIMIT,
  });

  const rows = _applyPerSourceCap(prelim, MAX_PER_SOURCE);
  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity, { skipCityPenalty: true });
  return limit ? ranked.slice(offset, offset + limit) : ranked.slice(offset);
}

// ─────────────────────────────────────────────────────────────
// GLOBAL FEED
// Same pipeline as getRankedArticles but with no country filter.
// This is what powers the "Feed" tab (default, no-filter query on
// /api/news/search). Previously that endpoint ran its own SQL; this
// restores it to the shared ranking pipeline so calculatePriority +
// diversityRerank + in-thread boost + city-cap all apply.
//
// Selects country_boost and catalog_image_url so the caller can apply
// country-feed boosts and the frontend gets the image field it expects
// for parity with the old SQL response shape.
// ─────────────────────────────────────────────────────────────

async function getRankedFeedArticles(options = {}) {
  const limit   = parseOptionalPositiveInt(options.limit);
  const offset  = Math.max(parseInt(options.offset, 10) || 0, 0);
  const ambient = !!options.ambient;
  const hours   = Number.isFinite(options.hours) && options.hours > 0
    ? options.hours
    : CANDIDATE_WINDOW_HOURS;

  // Bound the candidate pool pushed into JS rank. Before this cap the query
  // was returning 70k+ rows (full 72h × all sources), each carrying two
  // correlated subqueries and three LEFT JOINs — caused multi-second
  // response times and mobile timeouts. 1500 is generous enough that
  // diversityRerank/countryVarianceRerank still have room to work, while
  // letting Postgres pre-filter by base_priority before the expensive joins.
  const POOL_LIMIT = Math.max(
    500,
    Math.min(2000, (parseOptionalPositiveInt(options.poolLimit) || 1500))
  );

  const ambientJoin  = ambient ? `LEFT JOIN news_sources ns_amb ON ns_amb.id = a.source_id` : "";
  const ambientWhere = ambient
    ? `AND COALESCE(ns_amb.fetch_tier, 1) IN (2, 3, 4) AND COALESCE(a.base_priority, 0) >= ${AMBIENT_MIN_BASE_PRIORITY}`
    : "";

  // Pull a wider prelim pool (poolMultiplier × POOL_LIMIT) ordered by
  // base_priority using the dedicated (base_priority DESC, published_at DESC)
  // partial index. This avoids the expensive ROW_NUMBER window function
  // that was the prior bottleneck (sorted the entire 70k-row candidate set
  // just to compute per-source ranks).
  //
  // After the SQL returns, we apply the per-source cap in JavaScript, which
  // is trivially fast on a few-thousand-row array.
  const PRELIM_MULTIPLIER = 3;
  const prelimLimit = POOL_LIMIT * PRELIM_MULTIPLIER;

  const { rows: prelimRows } = await pool.query(`
    SELECT ${ARTICLE_FIELDS},
      COALESCE(cfb.boost_score, 1.0) AS country_boost,
      img_a.public_url AS catalog_image_url,
      (EXISTS (SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id)) AS in_thread,
      (
        SELECT CASE
          WHEN bool_or(t.status = 'active')  THEN 'active'
          WHEN bool_or(t.status = 'cooling') THEN 'cooling'
          WHEN bool_or(t.status = 'dormant') THEN 'dormant'
          ELSE NULL
        END
        FROM story_thread_articles sta2
        JOIN story_threads t ON t.id = sta2.thread_id
        WHERE sta2.article_id = a.id
      ) AS thread_status
    FROM news_articles a
    ${ambientJoin}
    ${ARTICLE_JOINS}
    LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
    LEFT JOIN LATERAL (
      SELECT img.public_url
      FROM article_image_assignments aia
      JOIN image_assets img ON img.id = aia.image_id
      WHERE aia.article_id = a.id
      ORDER BY COALESCE(aia.refreshed_at, aia.assigned_at) DESC NULLS LAST
      LIMIT 1
    ) img_a ON true
    WHERE a.city_id IS NULL
      AND a.published_at > NOW() - INTERVAL '${hours} hours'
      AND a.published_at <= NOW()
      ${ambientWhere}
    ORDER BY a.base_priority DESC NULLS LAST, a.published_at DESC NULLS LAST
    LIMIT $1
  `, [prelimLimit]);

  // JS-side per-source cap: preserves priority ordering while ensuring no
  // single outlet floods the pool. Runs in O(n) on ≤ POOL_LIMIT * 3 rows.
  const perSourceCount = new Map();
  const rows = [];
  for (const r of prelimRows) {
    const key = r.source_key || (r.source_id ? `news:${r.source_id}` : `yt:${r.youtube_source_id}`);
    const n = perSourceCount.get(key) || 0;
    if (n >= MAX_PER_SOURCE) continue;
    perSourceCount.set(key, n + 1);
    rows.push(r);
    if (rows.length >= POOL_LIMIT) break;
  }

  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity);

  // Apply country_boost as a terminal multiplier on priority, then
  // stable-resort (insertion-style) by boosted priority. We don't
  // full-sort because rankArticles already ran diversityRerank and the
  // boost should nudge within equivalence classes, not blow up the
  // diversity arrangement. A simple multiply + re-sort is close enough
  // in practice and the caller's countryVarianceRerank runs as the
  // terminal pass anyway.
  for (const a of ranked) {
    const boost = parseFloat(a.country_boost) || 1;
    a.priority = (a.priority || 0) * boost;
  }
  ranked.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return limit ? ranked.slice(offset, offset + limit) : ranked.slice(offset);
}

module.exports = { getRankedArticles, getRankedCityArticles, getRankedFeedArticles };
