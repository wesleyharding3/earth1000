/**
 * PRIORITY ENGINE
 *
 * final_score =
 *   normalizedIntensity *
 *   tagMultiplier *
 *   popularity_score
 *
 * System guarantees:
 * - popularity_score capped at 1.60
 * - normalizedIntensity clamped 0–1
 * - tagMultiplier bounded
 * - deterministic output
 */

const CONFIG = {
  MIN_POPULARITY: 0.90,
  MAX_POPULARITY: 1.60,
  MAX_TAG_MULTIPLIER: 1.20,
  MIN_TAG_MULTIPLIER: 1.00,
  TIER_BONUS: {
    4: 10.0,  // tier 4 always floats to top
    3: 1.0,
    2: 1.0,
    1: 1.0
  }
};

function getTierBonus(tier) {
  return CONFIG.TIER_BONUS[tier] ?? 1.0;
}




/**
 * Normalize raw intensity against country max
 */
function normalizeIntensity(rawIntensity, maxIntensity) {
  if (!maxIntensity || maxIntensity <= 0) return 0;

  const normalized = rawIntensity / maxIntensity;

  if (normalized < 0) return 0;
  if (normalized > 1) return 1;

  return normalized;
}

/**
 * Tag multiplier based on cumulative tag weight strength.
 *
 * Expected input: sum of active tag weights for matched tags.
 */
function computeTagMultiplier(tagWeightSum = 0) {
  if (tagWeightSum <= 1.5) return 1.00;
  if (tagWeightSum <= 3.0) return 1.10;

  return CONFIG.MAX_TAG_MULTIPLIER; // hard cap
}

/**
 * Clamp popularity score to allowed tier range.
 */
function clampPopularity(score) {
  if (!score) return CONFIG.MIN_POPULARITY;

  if (score < CONFIG.MIN_POPULARITY)
    return CONFIG.MIN_POPULARITY;

  if (score > CONFIG.MAX_POPULARITY)
    return CONFIG.MAX_POPULARITY;

  return score;
}

/**
 * Core deterministic priority calculation.
 */
function calculatePriority({
  rawIntensity,
  maxIntensity,
  tagWeightSum,
  popularityScore,
  popularityTier        // ← add this
}) {
  const normalized    = normalizeIntensity(rawIntensity, maxIntensity);
  const tagMultiplier = computeTagMultiplier(tagWeightSum);
  const popularity    = clampPopularity(popularityScore);
  const tierBonus     = getTierBonus(popularityTier);  // ← add this

  const finalScore =
    normalized *
    tagMultiplier *
    popularity *
    tierBonus;           // ← multiply in

  return Number(finalScore.toFixed(8));
}

/**
 * Rank articles by descending priority.
 */
function rankArticles(articles = [], maxIntensity) {
  return articles
    .map(article => ({
      ...article,
      priority: calculatePriority({
        rawIntensity: article.intensity || 0,
        maxIntensity,
        tagWeightSum: article.tagWeightSum || 0,
        popularityScore: article.popularity_score,
        popularityTier:  article.popularity_tier
      })
    }))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Optional: detect over-tiering distortion
 */
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
  detectTierInflation
};