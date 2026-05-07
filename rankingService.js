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
  -- Top-ranked tag from scoringEngine. Surfaces the article's primary
  -- category in the feed payload so cards can render a category badge.
  -- LATERAL aliased "att" to avoid colliding with the outer tag-filter
  -- join (which uses alias "at") when a caller passes ?tag=X.
  top_tag.tag_id                                            AS tag_id,
  top_tag.tag_name                                          AS tag_name,
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
  LEFT JOIN LATERAL (
    SELECT t.id AS tag_id, t.name AS tag_name
    FROM article_tags att
    JOIN tags t ON t.id = att.tag_id
    WHERE att.article_id = a.id
    ORDER BY att.rank ASC
    LIMIT 1
  ) top_tag ON TRUE
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

// Side-channel pool of YouTube videos for the given scope. The regular
// _loadCandidatePool is recency-ordered and capped (NATIONAL_POOL_LIMIT
// = 500-ish); videos are ~0.2% of ingest volume, so for any country
// the recency-limited pool typically contains ZERO videos — they get
// filtered out before ranking can ever surface them.
//
// This query bypasses the ambient/tag filters that gate the regular
// pool (so videos always show even on niche-content browsing) and
// pulls the most recent N videos for the scope. The caller merges these
// with the regular pool, deduplicating by article id so a video that
// happens to be in both pools doesn't double-count.
//
// CRITICAL: this MUST be fault-tolerant. It runs in Promise.all alongside
// _loadCandidatePool, so a slow/errored video query would otherwise reject
// the whole Promise.all and 500 the entire feed — the bug pattern we hit
// when this was first added. An empty array on failure means "no extra
// videos this request"; the regular pool is unaffected.
const VIDEO_POOL_LIMIT = 12;
const VIDEO_POOL_TIMEOUT_MS = 5_000;
async function _loadVideoPool({ scopeSql, scopeParams }) {
  // Tight statement_timeout so the side-channel can never pull down the
  // main feed query — this side path is "best effort." Use a dedicated
  // client so the timeout doesn't leak to neighbouring queries.
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${VIDEO_POOL_TIMEOUT_MS}`);
    const { rows } = await client.query(`
      SELECT ${ARTICLE_FIELDS},
        false AS in_thread,
        NULL AS thread_status
      FROM news_articles a
      ${ARTICLE_JOINS}
      WHERE ${scopeSql}
        AND a.youtube_source_id IS NOT NULL
        AND a.published_at > NOW() - INTERVAL '${CANDIDATE_WINDOW_HOURS} hours'
      ORDER BY a.published_at DESC NULLS LAST
      LIMIT ${VIDEO_POOL_LIMIT}
    `, scopeParams);
    return rows;
  } catch (err) {
    // Swallow and continue with the regular pool. Logged at warn so the
    // miss is visible in cron/Render logs without paging.
    console.warn(`[rankingService] video pool query failed (continuing without): ${err.message}`);
    return [];
  } finally {
    // Best-effort reset so the pool default is restored before the
    // connection goes back; release happens regardless.
    try { await client.query('SET statement_timeout = 45000'); } catch (_) {}
    client.release();
  }
}

function _isVideo(a) {
  return a.media_type === 'video' || (a.video_id != null && a.video_id !== '');
}

// Mirrors getRankedFeedArticles' video boost + guaranteed-slot logic
// so country and city feeds also surface videos consistently. Returns
// the final slice (or full ranked list when no limit given).
//
// Two stages:
//   1. Multiply each video's priority by VIDEO_BOOST (2.5×). This
//      pushes them up the rank order without disturbing the
//      diversityRerank that already ran inside rankArticles — the
//      boost only nudges within an equivalence class.
//   2. After slicing for offset/limit, if the slice contains fewer
//      than MIN_VIDEOS videos and there are videos lower in the
//      pool, swap the lowest-priority text article in the slice for
//      the highest-priority video outside it. Guarantees ≥2 videos
//      per page even when the boost alone wasn't enough.
const VIDEO_BOOST = 2.5;
const MIN_VIDEOS_PER_SLICE = 2;
function _applyVideoBoostAndGuaranteedSlot(ranked, limit, offset) {
  for (const a of ranked) {
    if (_isVideo(a)) a.priority = (a.priority || 0) * VIDEO_BOOST;
  }
  ranked.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  if (!limit) return ranked.slice(offset);

  const slice = ranked.slice(offset, offset + limit);
  const sliceVideos = slice.filter(_isVideo);
  if (sliceVideos.length >= MIN_VIDEOS_PER_SLICE) return slice;

  const sliceIdSet = new Set(slice.map(a => a.id));
  const promotable = ranked
    .filter(a => !sliceIdSet.has(a.id) && _isVideo(a))
    .slice(0, MIN_VIDEOS_PER_SLICE - sliceVideos.length);
  if (!promotable.length) return slice;

  const replaceableIdx = slice
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => !_isVideo(r))
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

// Merge regular pool + video pool, deduplicating by article id. Videos
// already present in the regular pool are kept (single entry); new
// videos from the side-channel are appended.
function _mergeVideoPool(regular, videos) {
  const seen = new Set(regular.map(r => r.id));
  const out = regular.slice();
  for (const v of videos) {
    if (!seen.has(v.id)) {
      out.push(v);
      seen.add(v.id);
    }
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

  // Two parallel pools: the regular by-recency candidates AND a
  // side-channel of recent videos for this country. Without the
  // side-channel, the regular pool's recency cap excludes videos
  // entirely (~0.2% of ingest volume). See _loadVideoPool docstring.
  const scopeSql = `a.country_id = $1 AND a.city_id IS NULL`;
  const scopeParams = [countryId];
  const [prelim, videoPool] = await Promise.all([
    _loadCandidatePool({
      scopeSql,
      scopeParams,
      ambient,
      tagId,
      poolLimit: ambient ? AMBIENT_NATIONAL_POOL_LIMIT : NATIONAL_POOL_LIMIT,
    }),
    _loadVideoPool({ scopeSql, scopeParams }),
  ]);
  const merged = _mergeVideoPool(prelim, videoPool);

  const rows = _applyPerSourceCap(merged, MAX_PER_SOURCE);
  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity);
  return _applyVideoBoostAndGuaranteedSlot(ranked, limit, offset);
}

// ─────────────────────────────────────────────────────────────
// CITY FEED
// ─────────────────────────────────────────────────────────────

async function getRankedCityArticles(cityId, options = {}) {
  const limit  = parseOptionalPositiveInt(options.limit);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const tagId  = options.tagId ? parseInt(options.tagId) : null;
  const ambient = !!options.ambient;

  const scopeSql = `a.city_id = $1`;
  const scopeParams = [cityId];
  const [prelim, videoPool] = await Promise.all([
    _loadCandidatePool({
      scopeSql,
      scopeParams,
      ambient,
      tagId,
      poolLimit: ambient ? AMBIENT_CITY_POOL_LIMIT : CITY_POOL_LIMIT,
    }),
    _loadVideoPool({ scopeSql, scopeParams }),
  ]);
  const merged = _mergeVideoPool(prelim, videoPool);

  const rows = _applyPerSourceCap(merged, MAX_PER_SOURCE);
  const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
  const ranked = rankArticles(rows, maxIntensity, { skipCityPenalty: true });
  return _applyVideoBoostAndGuaranteedSlot(ranked, limit, offset);
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

  // country_boost is unique to the global feed (the country and city
  // feeds don't carry it). Apply it before delegating to the shared
  // video-boost + guaranteed-slot helper, which handles VIDEO_BOOST,
  // re-sort, and the slot-swap safety net for all three feed flavours.
  for (const a of ranked) {
    const countryBoost = parseFloat(a.country_boost) || 1;
    a.priority = (a.priority || 0) * countryBoost;
  }
  return _applyVideoBoostAndGuaranteedSlot(ranked, limit, offset);
}

module.exports = { getRankedArticles, getRankedCityArticles, getRankedFeedArticles };
