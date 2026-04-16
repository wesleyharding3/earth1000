// scoringEngine.js
const pool = require("./db");

/*
=========================================================
CONFIGURATION
=========================================================
*/
const ALPHA           = 0.35;
const BETA            = 0.65;
const FLIP_THRESHOLD  = 1.15;
const TITLE_WEIGHT    = 1.8;

/*
=========================================================
HELPERS
=========================================================
*/
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  const t = (text || "").trim();
  if (!t) return 1;
  return t.split(/\s+/).length;
}

/*
=========================================================
MAIN
=========================================================
*/
async function classifyArticle(articleId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const articleRes = await client.query(
      `SELECT id, source_id,
              COALESCE(translated_title, title)     AS translated_title,
              COALESCE(translated_summary, summary) AS translated_summary
       FROM news_articles
       WHERE id = $1`,
      [articleId]
    );

    if (!articleRes.rows.length) throw new Error("Article not found");

    const article     = articleRes.rows[0];
    const normTitle   = normalize(article.translated_title);
    const normSummary = normalize(article.translated_summary);
    const totalWords  = wordCount(normTitle) + wordCount(normSummary);

    const priorRes = await client.query(
      `SELECT tag_id, weight
       FROM source_tag_weights
       WHERE source_id = $1`,
      [article.source_id]
    );

    const sourcePriors = {};
    priorRes.rows.forEach(r => {
      sourcePriors[r.tag_id] = parseFloat(r.weight);
    });

    const keywordRes = await client.query(`
      SELECT
        tk.tag_id,
        k.phrase,
        k.is_phrase,
        kt.base_score
      FROM tag_keywords tk
      JOIN keywords      k  ON k.id  = tk.keyword_id
      JOIN keyword_tiers kt ON kt.id = tk.tier_id
    `);

    const tagKeywordScores = {};

    for (const row of keywordRes.rows) {
      const phrase    = normalize(row.phrase);
      const baseScore = parseFloat(row.base_score);
      const tagId     = row.tag_id;

      let titleHits   = 0;
      let summaryHits = 0;

      if (row.is_phrase) {
        const re    = new RegExp(`\\b${phrase}\\b`, "g");
        titleHits   = (normTitle.match(re)   || []).length;
        summaryHits = (normSummary.match(re) || []).length;
      } else {
        titleHits   = normTitle.split(" ").filter(w => w === phrase).length;
        summaryHits = normSummary.split(" ").filter(w => w === phrase).length;
      }

      const weightedHits = (titleHits * TITLE_WEIGHT) + summaryHits;
      if (weightedHits === 0) continue;

      const intensity = (weightedHits * baseScore) / Math.sqrt(totalWords);
      tagKeywordScores[tagId] = (tagKeywordScores[tagId] || 0) + intensity;
    }

    const allTagIds = new Set([
      ...Object.keys(sourcePriors).map(Number),
      ...Object.keys(tagKeywordScores).map(Number)
    ]);

    const finalScores = [];

    for (const tagId of allTagIds) {
      const prior        = sourcePriors[tagId]     || 0;
      const keywordScore = tagKeywordScores[tagId] || 0;

      const weightedPrior   = prior        * ALPHA;
      const weightedKeyword = keywordScore * BETA;

      let combined = weightedPrior + weightedKeyword;

      if (
        weightedKeyword > weightedPrior &&
        weightedPrior > 0 &&
        weightedKeyword >= weightedPrior * FLIP_THRESHOLD
      ) {
        combined *= 1.1;
      }

      finalScores.push({ tagId, prior, keywordScore, combined });
    }

    finalScores.sort((a, b) => b.combined - a.combined);

    if (!finalScores.length) {
      await client.query("COMMIT");
      return { success: false, reason: "No classification signal" };
    }

    await client.query(
      `DELETE FROM article_tags WHERE article_id = $1`,
      [articleId]
    );

    const topTags = finalScores.slice(0, 3);

    for (let i = 0; i < topTags.length; i++) {
      const { tagId, combined } = topTags[i];
      await client.query(
        `INSERT INTO article_tags (article_id, tag_id, rank, score)
         VALUES ($1, $2, $3, $4)`,
        [articleId, tagId, i + 1, combined]
      );
    }

    const topScore = topTags[0]?.combined || 0;

    await client.query(
      `UPDATE news_articles
       SET base_priority = $1
       WHERE id = $2`,
      [topScore, articleId]
    );

    await client.query("COMMIT");

    return { success: true, topTags };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("classifyArticle error:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { classifyArticle };


/**
 * PRIORITY ENGINE
 *
 * final_score =
 *   blend(recencyScore * 0.75, qualityScore * 0.25) *
 *   tierBonus *
 *   cityPenalty
 *
 * Where:
 *   recencyScore = exponential decay from publishedAt (half-life 24h), normalized 0→1
 *   qualityScore = normalizedIntensity * tagMultiplier * popularityScore, normalized 0→1
 *
 * Recency is the dominant signal (~75%). Quality, tier, and source diversity
 * act as secondary modifiers so that among equally-fresh articles, better
 * content still surfaces first.
 *
 * City source guarantees:
 * - City articles scored with CITY_SOURCE_PENALTY multiplier (0.01)
 * - Hard cap of max 1 city article per 20-article window
 * - Excess city articles deferred to end of feed, sorted by priority
 * - City feed itself bypasses penalty via skipCityPenalty option
 */

const CONFIG = {
  MIN_POPULARITY:      0.90,
  MAX_POPULARITY:      1.60,
  YOUTUBE_POPULARITY_FLOOR: 1.25,
  YOUTUBE_PRIORITY_BOOST:   1.18,
  // Articles in story threads rank higher in node feeds. The boost is
  // tiered by the parent thread's lifecycle status: active threads get
  // a much larger multiplier so they surface at the top of country/city
  // panels, cooling threads a smaller boost, dormant essentially no
  // boost (they're archived).
  THREAD_BOOST:             1.55,   // back-compat alias (= cooling tier)
  THREAD_BOOST_ACTIVE:      3.00,
  THREAD_BOOST_COOLING:     1.55,
  THREAD_BOOST_DORMANT:     1.05,
  MAX_TAG_MULTIPLIER:  1.20,
  MIN_TAG_MULTIPLIER:  1.00,
  CITY_SOURCE_PENALTY: 0.01,
  FLOW_CITY_PENALTY:   0.50,   // Gentler penalty for flows - city articles can still compete
  TIER_BONUS: {
    4: 6.0,
    3: 1.0,
    2: 1.0,
    1: 1.0
  },
  DECAY: {
    HALF_LIFE_HOURS: 24,
    MIN_DECAY:       0.05
  },
  // Blend: variation enforced by diversityRerank, recency dominates within
  // eligible set, quality (base_priority × popularity × tags) is a tiebreaker.
  SCORE_BLEND: {
    RECENCY:  0.85,
    QUALITY:  0.15
  },
  DIVERSITY: {
    // Hard cooldown: a source is completely blocked for this many slots after
    // appearing. Deterministic — no soft-penalty math that dominant sources
    // can overpower. Tune up to tighten mixing, down to allow more repeats.
    COOLDOWN_SLOTS: 5
  },
  CITY_FEED: {
    CAP_PER_WINDOW: 1,
    WINDOW_SIZE:    20
  }
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function getTierBonus(tier) {
  return CONFIG.TIER_BONUS[Number(tier)] ?? 1.0;
}

function normalizeIntensity(rawIntensity, maxIntensity) {
  if (!maxIntensity || maxIntensity <= 0) return 0;
  const normalized = rawIntensity / maxIntensity;
  if (normalized < 0) return 0;
  if (normalized > 1) return 1;
  return normalized;
}

function computeTagMultiplier(tagWeightSum = 0) {
  if (tagWeightSum <= 1.5) return 1.00;
  if (tagWeightSum <= 3.0) return 1.10;
  return CONFIG.MAX_TAG_MULTIPLIER;
}

function clampPopularity(score) {
  if (!score) return CONFIG.MIN_POPULARITY;
  if (score < CONFIG.MIN_POPULARITY) return CONFIG.MIN_POPULARITY;
  if (score > CONFIG.MAX_POPULARITY) return CONFIG.MAX_POPULARITY;
  return score;
}

function getEffectivePopularity(score, { isYouTube = false } = {}) {
  const clamped = clampPopularity(score);
  if (!isYouTube) return clamped;
  return Math.max(clamped, CONFIG.YOUTUBE_POPULARITY_FLOOR);
}

function computeDecay(publishedAt) {
  if (!publishedAt) return 1.0;
  const ageMs    = Date.now() - new Date(publishedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= 0) return 1.0;
  const decay = Math.pow(0.5, ageHours / CONFIG.DECAY.HALF_LIFE_HOURS);
  return Math.max(decay, CONFIG.DECAY.MIN_DECAY);
}

// ─────────────────────────────────────────────────────────────
// CORE PRIORITY CALCULATION
// ─────────────────────────────────────────────────────────────

function calculatePriority({
  rawIntensity,
  maxIntensity,
  tagWeightSum,
  popularityScore,
  popularityTier,
  publishedAt,
  isYouTube,
  isCitySource,
  cityPenaltyOverride,
  inThread,
  threadStatus
}) {
  // Recency: exponential decay score, 0→1 (fresh = 1.0, old = MIN_DECAY)
  const recencyScore = computeDecay(publishedAt);

  // Quality: content signal rolled into a single 0→1 value.
  // popularityScore is already clamped so its range is bounded; we divide by
  // MAX_POPULARITY to nudge it back toward 0→1 before blending.
  const normalized    = normalizeIntensity(rawIntensity, maxIntensity);
  const tagMultiplier = computeTagMultiplier(tagWeightSum);
  const popularity    = getEffectivePopularity(popularityScore, { isYouTube });
  const qualityScore  = Math.min(1, (normalized * tagMultiplier * popularity) / CONFIG.MAX_POPULARITY);

  // Blend: recency dominates at 75%
  const { RECENCY, QUALITY } = CONFIG.SCORE_BLEND;
  const blended = (RECENCY * recencyScore) + (QUALITY * qualityScore);

  // Tier bonus and city penalty are applied after blending so they can still
  // meaningfully separate articles within the same recency band.
  const tierBonus   = getTierBonus(popularityTier);
  const defaultPenalty = CONFIG.CITY_SOURCE_PENALTY;
  const cityPenalty = isCitySource 
    ? (cityPenaltyOverride !== undefined ? cityPenaltyOverride : defaultPenalty) 
    : 1.0;

  const surfaceBoost = isYouTube ? CONFIG.YOUTUBE_PRIORITY_BOOST : 1.0;
  // Thread boost tiered by parent thread status: active threads
  // surface at the top, cooling threads get a moderate lift, dormant
  // threads barely boost at all. Falls back to the uniform THREAD_BOOST
  // when threadStatus isn't provided (e.g. search feed).
  const threadBoost = !inThread ? 1.0
    : threadStatus === 'active'  ? CONFIG.THREAD_BOOST_ACTIVE
    : threadStatus === 'cooling' ? CONFIG.THREAD_BOOST_COOLING
    : threadStatus === 'dormant' ? CONFIG.THREAD_BOOST_DORMANT
    : CONFIG.THREAD_BOOST;   // legacy fallback (1.55)
  const finalScore = blended * tierBonus * cityPenalty * surfaceBoost * threadBoost;

  return parseFloat(finalScore.toFixed(8));
}

// ─────────────────────────────────────────────────────────────
// DIVERSITY PASS
// ─────────────────────────────────────────────────────────────

function diversityRerank(articles) {
  if (!articles.length) return articles;

  const { COOLDOWN_SLOTS } = CONFIG.DIVERSITY;

  const pool   = articles.map((a, i) => ({ ...a, _origIdx: i }));
  const result = [];

  // cooldowns[sourceKey] = number of slots remaining before this source
  // is eligible again. Counts down by 1 each slot regardless of what's picked.
  const cooldowns = {};

  const getSourceKey = (article) =>
    article.source_key
    || (article.youtube_source_id != null ? `youtube:${article.youtube_source_id}` : null)
    || (article.source_id != null         ? `news:${article.source_id}`             : "unknown");

  while (pool.length) {
    // Tick all cooldowns down by 1
    for (const src of Object.keys(cooldowns)) {
      cooldowns[src]--;
      if (cooldowns[src] <= 0) delete cooldowns[src];
    }

    // Pick best eligible article (not on cooldown).
    // Within eligible set: priority is already recency-dominant so this
    // naturally gives variation > recency > base_priority ordering.
    let bestIdx   = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const src = getSourceKey(pool[i]);
      if (cooldowns[src]) continue;
      if (pool[i].priority > bestScore) {
        bestScore = pool[i].priority;
        bestIdx   = i;
      }
    }

    // Fallback: every remaining source is on cooldown (feed has very few sources).
    // Pick the one whose cooldown expires soonest, break tie by priority.
    if (bestIdx === -1) {
      let minCooldown = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const src = getSourceKey(pool[i]);
        const cd  = cooldowns[src] || 0;
        if (cd < minCooldown || (cd === minCooldown && pool[i].priority > pool[bestIdx]?.priority)) {
          minCooldown = cd;
          bestIdx     = i;
        }
      }
    }

    const chosen = pool.splice(bestIdx, 1)[0];
    result.push(chosen);
    cooldowns[getSourceKey(chosen)] = COOLDOWN_SLOTS;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// COUNTRY VARIANCE PASS
// ─────────────────────────────────────────────────────────────

function countryVarianceRerank(articles) {
  if (!articles.length) return articles;

  const MAX_PENALTY = 1.5;
  const DECAY       = 0.25;
  const MAX_REPEAT  = 2;

  const now    = Date.now();
  const ages   = articles.map(a => now - new Date(a.published_at).getTime());
  const maxAge = Math.max(...ages) || 1;

  // Recency bonus weight raised to 0.50 (from 0.25) to stay consistent with
  // the dominant-recency philosophy applied in calculatePriority.
  const pool      = articles.map(a => ({
    ...a,
    _recencyBonus: 1 + 0.50 * (1 - (now - new Date(a.published_at).getTime()) / maxAge)
  }));
  const result    = [];
  const penalties = {};

  while (pool.length) {
    const blocked = new Set();

    if (result.length >= MAX_REPEAT) {
      const tail        = result.slice(-MAX_REPEAT);
      const lastCountry = tail[0].country_name;
      if (tail.every(a => a.country_name === lastCountry)) {
        blocked.add(lastCountry);
      }
    }

    let bestIdx   = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const a = pool[i];
      if (blocked.has(a.country_name)) continue;
      const penalty = penalties[a.country_name] || 0;
      const score   = a.final_priority * a._recencyBonus * (1 - penalty);
      if (score > bestScore) {
        bestScore = score;
        bestIdx   = i;
      }
    }

    if (bestIdx === -1) bestIdx = 0;

    const chosen = pool.splice(bestIdx, 1)[0];
    result.push(chosen);

    for (const c of Object.keys(penalties)) {
      penalties[c] = penalties[c] * (1 - DECAY);
      if (penalties[c] < 0.01) delete penalties[c];
    }
    penalties[chosen.country_name] =
      Math.min(MAX_PENALTY, (penalties[chosen.country_name] || 0) + MAX_PENALTY);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

function rankArticles(articles = [], maxIntensity, options = {}) {
  const skipCityPenalty = options.skipCityPenalty || false;

  // Step 1: score every article
  const scored = articles.map(article => ({
    ...article,
    priority: calculatePriority({
      rawIntensity:    article.intensity || 0,
      maxIntensity,
      tagWeightSum:    article.tagWeightSum || 0,
      popularityScore: article.popularity_score,
      popularityTier:  article.popularity_tier,
      publishedAt:     article.published_at,
      isYouTube:       article.youtube_source_id != null,
      isCitySource:    skipCityPenalty ? false : !!article.city_id,
      inThread:        !!article.in_thread,
      threadStatus:    article.thread_status || null
    })
  }));

  // Step 2: sort by raw priority, tiebreak by recency
  scored.sort((a, b) => {
    const scoreDiff = b.priority - a.priority;
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return new Date(b.published_at) - new Date(a.published_at);
  });

  // Step 3: reorder for source variance
  const reranked = diversityRerank(scored);

  // Step 4: enforce city concentration cap (skip if city feed)
  if (skipCityPenalty) return reranked;

  const { CAP_PER_WINDOW, WINDOW_SIZE } = CONFIG.CITY_FEED;

  const result      = [];
  const deferred    = [];
  const windowQueue = [];
  let cityCountInWindow = 0;

  for (const article of reranked) {
    const isCity = article.city_id != null;

    if (isCity && cityCountInWindow >= CAP_PER_WINDOW) {
      deferred.push(article);
      continue;
    }

    result.push(article);
    windowQueue.push(isCity);
    if (isCity) cityCountInWindow++;

    if (windowQueue.length > WINDOW_SIZE) {
      const evicted = windowQueue.shift();
      if (evicted) cityCountInWindow--;
    }
  }

  deferred.sort((a, b) => b.priority - a.priority);
  return [...result, ...deferred];
}

function detectTierInflation(sources = []) {
  const tier3Count = sources.filter(s => s.popularity_tier === 3).length;
  const tier4Count = sources.filter(s => s.popularity_tier === 4).length;
  const total = sources.length || 1;
  return {
    tier3Ratio: tier3Count / total,
    tier4Ratio: tier4Count / total,
    warning:
      (tier3Count / total > 0.12) ||
      (tier4Count / total > 0.03)
  };
}

module.exports = {
  calculatePriority,
  rankArticles,
  diversityRerank,
  countryVarianceRerank,
  detectTierInflation,
  FLOW_CITY_PENALTY: CONFIG.FLOW_CITY_PENALTY
};
