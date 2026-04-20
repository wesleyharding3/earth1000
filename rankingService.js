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
// Ambient queries apply base_priority >= 2.0 + tier 2-4 — that's already
// the top ~1.5% of the candidate universe. Pulling 800 rows for ambient
// means the planner has to scan far more article rows than end up in the
// ranked set, just to hit the limit. 200 leaves ample room for the per-
// source cap + rank/diversify while letting the index scan short-circuit
// much sooner, which was the dominant cost under load.
const AMBIENT_NATIONAL_POOL_LIMIT = 200;
const AMBIENT_CITY_POOL_LIMIT     = 100;

// No per-query statement_timeout here — `pool.connect()` + `SET` was grabbing
// a dedicated connection per request, and when many fed stacked up (country
// warmer + real traffic + search fallbacks) the pool exhausted. We use plain
// `pool.query()` now, so each request consumes one pool slot for however long
// the query actually needs, capped by the pool-wide default (45s).

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
// QUERY BUILDER
// ─────────────────────────────────────────────────────────────
//
// Fetches up to `poolLimit` articles matching the scope (country/city filter)
// ordered by published_at DESC. Thread status (`in_thread`, `thread_status`)
// is consolidated into a single LATERAL lookup — previously we issued two
// separate correlated subqueries against story_thread_articles for every row,
// which on cold buffer cache tipped the whole feed query past our pool's
// 45s statement_timeout and returned 500s to the client.
//
// Uses `pool.query()` (one pool slot, auto-released). The prior per-request
// `pool.connect()` + `SET statement_timeout` pattern was piling dedicated
// connections onto the pool under load — under fan-out the pool exhausted and
// neighboring endpoints (news/search tiered fallbacks, image lookups) all
// started erroring with "Cannot use a pool after calling end on the pool"
// once Render cycled the process.

function _buildAmbientClauses(ambient) {
  // `ns` is already joined via ARTICLE_JOINS as a LEFT JOIN for the SELECT
  // fields (source_name, bias, site_url, popularity). When ambient is on,
  // filter on that existing alias rather than adding a second self-join
  // on news_sources. `ns.fetch_tier IN (…)` also implicitly excludes the
  // LEFT-JOIN nulls (YouTube-only rows, rows with no news_sources record),
  // matching the previous inner-join semantics.
  //
  // Removing the duplicate join eliminates an extra index lookup per
  // candidate row, which was the ambient feed's dominant cost on cold
  // buffer cache and under pool contention.
  return {
    join: "",
    where: ambient
      ? `AND ns.fetch_tier IN (2, 3, 4) AND a.base_priority >= ${AMBIENT_MIN_BASE_PRIORITY}`
      : "",
  };
}

function _buildTagClause(tagId) {
  return tagId
    ? `JOIN article_tags at ON at.article_id = a.id AND at.tag_id = ${parseInt(tagId, 10)}`
    : "";
}

async function _loadCandidatePool({ scopeSql, scopeParams, ambient, tagId, poolLimit }) {
  const { join: ambientJoin, where: ambientWhere } = _buildAmbientClauses(ambient);
  const tagJoin = _buildTagClause(tagId);

  // NOTE on the LATERAL shape: SELECT with an aggregate over an empty input
  // still returns one row (implicit grouping), so a literal `true` would be
  // true even when the article has zero story_thread_articles rows. Using
  // `count(*) > 0` over sta + a LEFT JOIN to story_threads gives the correct
  // in_thread flag AND the aggregated thread_status in a single pass.
  const sql = `
    SELECT ${ARTICLE_FIELDS},
      COALESCE(th.in_thread, false) AS in_thread,
      th.thread_status
    FROM news_articles a
    ${ARTICLE_JOINS}
    ${ambientJoin}
    ${tagJoin}
    LEFT JOIN LATERAL (
      SELECT
        count(*) > 0 AS in_thread,
        CASE
          WHEN bool_or(t.status = 'active')  THEN 'active'
          WHEN bool_or(t.status = 'cooling') THEN 'cooling'
          WHEN bool_or(t.status = 'dormant') THEN 'dormant'
          ELSE NULL
        END AS thread_status
      FROM story_thread_articles sta
      LEFT JOIN story_threads t ON t.id = sta.thread_id
      WHERE sta.article_id = a.id
    ) th ON TRUE
    WHERE ${scopeSql}
      AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
      ${ambientWhere}
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
    LIMIT ${poolLimit}
  `;

  const { rows } = await pool.query(sql, scopeParams);
  return rows;
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
    poolLimit: ambient ? AMBIENT_NATIONAL_POOL_LIMIT : NATIONAL_POOL_LIMIT,
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
    poolLimit: ambient ? AMBIENT_CITY_POOL_LIMIT : CITY_POOL_LIMIT,
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

  // Apply country_boost + video_boost as terminal multipliers on
  // priority, then stable-resort by boosted priority. We don't full-
  // sort because rankArticles already ran diversityRerank and the
  // boost should nudge within equivalence classes, not blow up the
  // diversity arrangement.
  //
  // VIDEO_BOOST (2.5×): kept in sync with server.js's same-named
  // constant in _finalizeSearchResults. Videos are ~0.2% of ingest
  // volume with comparable base_priority to text — empirically a 1.5×
  // boost produced zero video surfaces in the top 100 pool; 2.0×
  // produced one; 2.5× produces ~12. Landing 2–3 videos per feed
  // page is the target.
  const VIDEO_BOOST = 2.5;
  for (const a of ranked) {
    const countryBoost = parseFloat(a.country_boost) || 1;
    const isVideo = a.media_type === 'video' || (a.video_id != null && a.video_id !== '');
    const videoBoost = isVideo ? VIDEO_BOOST : 1.0;
    a.priority = (a.priority || 0) * countryBoost * videoBoost;
  }
  ranked.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // Guaranteed-slot safety net — mirrors _finalizeSearchResults.
  // After the boosted re-sort, if the returned slice would contain no
  // videos despite the pool having some, swap the lowest-priority text
  // article in the slice for the top-ranked video outside the slice.
  // Applied only to the slice that will actually be returned; keeps the
  // cost O(slice).
  if (limit) {
    const slice = ranked.slice(offset, offset + limit);
    const MIN_VIDEOS = 2;
    const sliceVideos = slice.filter(a => a.media_type === 'video' || (a.video_id != null && a.video_id !== ''));
    if (sliceVideos.length < MIN_VIDEOS) {
      const sliceIdSet = new Set(slice.map(a => a.id));
      const promotable = ranked
        .filter(a => !sliceIdSet.has(a.id) && (a.media_type === 'video' || (a.video_id != null && a.video_id !== '')))
        .slice(0, MIN_VIDEOS - sliceVideos.length);
      if (promotable.length) {
        const replaceableIdx = slice
          .map((r, i) => ({ i, r }))
          .filter(({ r }) => !(r.media_type === 'video' || (r.video_id != null && r.video_id !== '')))
          .sort((a, b) => (a.r.priority || 0) - (b.r.priority || 0))
          .slice(0, promotable.length)
          .map(x => x.i);
        for (let i = 0; i < promotable.length; i++) {
          const slot = replaceableIdx[i];
          if (slot == null) break;
          slice[slot] = promotable[i];
        }
        slice.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        return slice;
      }
    }
    return slice;
  }
  return ranked.slice(offset);
}

module.exports = { getRankedArticles, getRankedCityArticles, getRankedFeedArticles };
