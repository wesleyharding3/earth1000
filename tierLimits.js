'use strict';

const pool = require('./db');

// ─── Tier limit definitions ────────────────────────────────────────────────
//
// Re-tuned 2026 launch pass. Three rules drove the rewrite:
//   1. Higher tier must beat lower tier on EVERY measurable axis.
//      The old matrix had Enterprise translations capped at 20/month while
//      Free got 5/day = ~150/month. A user on the comparison page saw
//      "pay $24.99/mo, get fewer translations" and lost trust in the
//      whole pricing scheme. Fixed below.
//   2. Translation is the Enterprise hero feature. DeepL/Claude cost is
//      ~$0.0005-0.0075 per call AND the cache-first /api/translate path
//      makes repeats free, so unlimited is supportable at $24.99/mo.
//      Pro gets a 5× bump (5/day → 25/day) so the upgrade narrative is
//      "casual reader → power reader → professional reader, unlimited."
const LIMITS = {
  free: {
    briefingsPerWeek:        2,
    translationsPerDay:      5,
    translationsPerMonth:    null,   // daily cap applies
    explanationsPerDay:      1,      // small daily taste of AI context
    kwExplanationsPerDay:    0,      // enterprise-only feature
  },
  pro: {
    briefingsPerWeek:        Infinity,
    translationsPerDay:      25,     // 5× the free tier — clear "Pro = power user" upgrade
    translationsPerMonth:    null,   // daily cap applies
    explanationsPerDay:      5,
    kwExplanationsPerDay:    0,      // enterprise-only feature
  },
  enterprise: {
    briefingsPerWeek:        Infinity,
    // Unlimited translation — the Enterprise hero feature. Cache-first
    // backend means real cost is dominated by NEW translations, which a
    // single org rarely produces in volume. At $24.99/mo even a heavy
    // user (~1000 marginal translations/month × $0.0075) costs ~$7.50,
    // well within margin.
    translationsPerDay:      Infinity,
    translationsPerMonth:    null,
    explanationsPerDay:      20,
    kwExplanationsPerDay:    25,     // AI keyword context explanations
  },
};

function limitsFor(tier) {
  return LIMITS[tier] || LIMITS.free;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

// Atomically increments a column in user_usage for today.
// Returns the new count BEFORE clamping, so the caller can decide.
async function _upsertDailyUsage(userId, field) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    INSERT INTO user_usage (user_id, usage_date, ${field})
    VALUES ($1, $2, 1)
    ON CONFLICT (user_id, usage_date) DO UPDATE
      SET ${field} = user_usage.${field} + 1
    RETURNING ${field} AS new_count
  `, [userId, today]);
  return rows[0]?.new_count ?? 1;
}

async function _decrementDailyUsage(userId, field) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`
    UPDATE user_usage
    SET ${field} = GREATEST(${field} - 1, 0)
    WHERE user_id = $1 AND usage_date = $2
  `, [userId, today]);
}

async function _getMonthlyTranslations(userId) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(translations), 0)::int AS total
    FROM user_usage
    WHERE user_id = $1 AND usage_date >= $2
  `, [userId, monthStart.toISOString().slice(0, 10)]);
  return rows[0]?.total ?? 0;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Check and consume one translation credit.
 * Returns { allowed: bool, used: number, limit: number|'∞', resetNote: string }
 */
async function checkTranslation(userId, tier) {
  const lim = limitsFor(tier);

  // Enterprise: monthly cap
  if (lim.translationsPerMonth !== null) {
    const monthlyTotal = await _getMonthlyTranslations(userId);
    if (monthlyTotal >= lim.translationsPerMonth) {
      return {
        allowed:   false,
        used:      monthlyTotal,
        limit:     lim.translationsPerMonth,
        resetNote: 'Resets on the 1st of next month',
      };
    }
    // Consume
    await _upsertDailyUsage(userId, 'translations');
    return { allowed: true, used: monthlyTotal + 1, limit: lim.translationsPerMonth };
  }

  // Free / Pro: daily cap
  const dailyLimit = lim.translationsPerDay;
  if (dailyLimit === 0) return { allowed: false, used: 0, limit: 0, resetNote: 'Upgrade to translate articles' };
  if (dailyLimit === Infinity) return { allowed: true, used: 0, limit: Infinity };

  const newCount = await _upsertDailyUsage(userId, 'translations');
  if (newCount > dailyLimit) {
    await _decrementDailyUsage(userId, 'translations');
    return {
      allowed:   false,
      used:      dailyLimit,
      limit:     dailyLimit,
      resetNote: 'Resets at midnight',
    };
  }
  return { allowed: true, used: newCount, limit: dailyLimit };
}

/**
 * Check and consume one AI explanation credit.
 * Returns { allowed: bool, used: number, limit: number|'∞' }
 */
async function checkExplanation(userId, tier) {
  const lim = limitsFor(tier);
  const dailyLimit = lim.explanationsPerDay;

  if (dailyLimit === 0) {
    return { allowed: false, used: 0, limit: 0, resetNote: 'Upgrade to Pro or Enterprise' };
  }
  if (dailyLimit === Infinity) return { allowed: true, used: 0, limit: Infinity };

  const newCount = await _upsertDailyUsage(userId, 'explanations');
  if (newCount > dailyLimit) {
    await _decrementDailyUsage(userId, 'explanations');
    return {
      allowed:   false,
      used:      dailyLimit,
      limit:     dailyLimit,
      resetNote: 'Resets at midnight',
    };
  }
  return { allowed: true, used: newCount, limit: dailyLimit };
}

/**
 * Check whether a user can access a briefing episode.
 * Records the access if this is the first time this user opens this episode.
 * Returns { allowed: bool, used: number, limit: number|'∞' }
 */
async function checkBriefingAccess(userId, episodeId, tier) {
  const lim = limitsFor(tier);
  if (lim.briefingsPerWeek === Infinity) return { allowed: true };

  // Already opened this episode before → don't count again
  const { rows: existing } = await pool.query(`
    SELECT 1 FROM briefing_access_log WHERE user_id = $1 AND episode_id = $2
  `, [userId, episodeId]);
  if (existing.length) return { allowed: true };

  // Count distinct briefings accessed in the last 7 days
  const { rows: weekCount } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM briefing_access_log
    WHERE user_id = $1 AND accessed_at > NOW() - INTERVAL '7 days'
  `, [userId]);
  const count = weekCount[0]?.count ?? 0;

  if (count >= lim.briefingsPerWeek) {
    return {
      allowed:   false,
      used:      count,
      limit:     lim.briefingsPerWeek,
      resetNote: 'Upgrade to Pro for daily briefings',
    };
  }

  // Log this access
  await pool.query(`
    INSERT INTO briefing_access_log (user_id, episode_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [userId, episodeId]);

  return { allowed: true, used: count + 1, limit: lim.briefingsPerWeek };
}

/**
 * Check and consume one keyword AI explanation credit.
 * Enterprise-only: 25/day. Pro and Free: 0.
 * Returns { allowed: bool, used: number, limit: number }
 */
async function checkKwExplanation(userId, tier) {
  const lim = limitsFor(tier);
  const dailyLimit = lim.kwExplanationsPerDay;

  if (dailyLimit === 0) {
    return { allowed: false, used: 0, limit: 0, resetNote: 'Keyword AI Context is an Enterprise feature' };
  }
  if (dailyLimit === Infinity) return { allowed: true, used: 0, limit: Infinity };

  const newCount = await _upsertDailyUsage(userId, 'kw_explanations');
  if (newCount > dailyLimit) {
    await _decrementDailyUsage(userId, 'kw_explanations');
    return {
      allowed:   false,
      used:      dailyLimit,
      limit:     dailyLimit,
      resetNote: 'Resets at midnight',
    };
  }
  return { allowed: true, used: newCount, limit: dailyLimit };
}

/**
 * Returns a snapshot of a user's current usage for the frontend.
 */
async function getUsageSnapshot(userId, tier) {
  const lim = limitsFor(tier);
  const today = new Date().toISOString().slice(0, 10);

  const [dailyRow, weekRow, monthTransRow] = await Promise.all([
    pool.query(`SELECT translations, explanations, kw_explanations FROM user_usage WHERE user_id=$1 AND usage_date=$2`, [userId, today]),
    pool.query(`SELECT COUNT(*)::int AS c FROM briefing_access_log WHERE user_id=$1 AND accessed_at > NOW() - INTERVAL '7 days'`, [userId]),
    lim.translationsPerMonth !== null
      ? _getMonthlyTranslations(userId)
      : Promise.resolve(null),
  ]);

  const daily = dailyRow.rows[0] || {};
  return {
    translations: {
      used:  lim.translationsPerMonth !== null ? (monthTransRow ?? 0) : (daily.translations ?? 0),
      limit: lim.translationsPerMonth ?? lim.translationsPerDay,
      period: lim.translationsPerMonth !== null ? 'month' : 'day',
    },
    explanations: {
      used:  daily.explanations ?? 0,
      limit: lim.explanationsPerDay,
      period: 'day',
    },
    kwExplanations: {
      used:  daily.kw_explanations ?? 0,
      limit: lim.kwExplanationsPerDay,
      period: 'day',
    },
    briefings: {
      used:  weekRow.rows[0]?.c ?? 0,
      limit: lim.briefingsPerWeek,
      period: 'week',
    },
  };
}

module.exports = {
  LIMITS,
  limitsFor,
  checkTranslation,
  checkExplanation,
  checkKwExplanation,
  checkBriefingAccess,
  getUsageSnapshot,
};
