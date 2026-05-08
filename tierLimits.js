'use strict';

/**
 * tierLimits.js — credit-backed gate adapters.
 *
 * Single source of truth for paid features is now `creditLedger`. This
 * module is a thin compatibility shim that preserves the
 *   { allowed, used, limit, resetNote }
 * call shape used by existing route handlers, while internally spending
 * a user's weekly credit allowance via `creditLedger.consumeCredits`.
 *
 * Per-day translation/explanation/kw_explanation hard caps and the
 * `user_usage` row-counter were retired in favor of one weekly credit
 * pool — there is now ONE meter the user sees and ONE knob the server
 * spends against. See creditLedger.js for tier allowances and per-call
 * costs.
 */

const pool    = require('./db');
const credits = require('./creditLedger');

// ─── Shape helpers ─────────────────────────────────────────────────────────

// Translate a creditLedger result into the legacy { allowed, used, limit,
// resetNote } shape that route handlers (and the frontend's 429 handler)
// already understand. Admin runs return Infinity; we surface that as the
// sentinel the legacy code already handled (limit:Infinity, used:0).
function _shape(result) {
  if (result.admin) {
    return { allowed: true, used: 0, limit: Infinity };
  }
  if (result.allowed) {
    // Used = credits already spent this week from base allowance.
    // Limit = weekly base allowance. Mirrors the old "X / Y per week" UX.
    const used = Math.max(0, (result.weekly_limit || 0) - (result.base_remaining ?? 0));
    return { allowed: true, used, limit: result.weekly_limit ?? 0 };
  }
  // Refused — surface the same fields the frontend already renders.
  return {
    allowed:   false,
    used:      result.weekly_limit ?? 0,
    limit:     result.weekly_limit ?? 0,
    resetNote: result.reason === 'auth_required'
      ? 'Sign in to use this feature'
      : 'Out of credits — refills Monday',
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Spend one translation's worth of credits.
 * Free's 20 credit/week → 20 translations/week (translate costs 1 credit).
 * Cache hits do NOT call this — see /api/translate cache-first path.
 */
async function checkTranslation(userId, tier, opts = {}) {
  const r = await credits.consumeCredits(userId, tier || 'free', 'translate', opts);
  return _shape(r);
}

/**
 * Episode-scoped briefing access gate. Idempotent on (user_id, episode_id):
 * the FIRST time a user opens an episode we charge `briefing_listen`
 * credits and write the access log; every subsequent listen of the same
 * episode is free (so a paused-and-resumed segment doesn't double-bill).
 *
 * `briefing_access_log` is the source of truth for "has this user
 * already paid for this episode" — keyed by its existing PK
 * (user_id, episode_id).
 */
async function checkBriefingAccess(userId, episodeId, tier, opts = {}) {
  if (!userId) return { allowed: true };

  // Already accessed → no charge, just allow. Same idempotency the old
  // implementation relied on, just reused as the credit-bypass signal.
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM briefing_access_log WHERE user_id = $1 AND episode_id = $2`,
    [userId, episodeId]
  );
  if (existing.length) return { allowed: true };

  const r = await credits.consumeCredits(
    userId,
    tier || 'free',
    'briefing_listen',
    { ...opts, referenceId: `briefing:${episodeId}` }
  );
  if (!r.allowed && !r.admin) return _shape(r);

  // Spend recorded — log the access. ON CONFLICT DO NOTHING guards
  // against a parallel double-listen racing past the SELECT above.
  await pool.query(
    `INSERT INTO briefing_access_log (user_id, episode_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, episodeId]
  );
  return _shape(r);
}

/**
 * Snapshot of the user's quota state for the frontend. Now a thin wrapper
 * over creditLedger.getBalance so the dashboard / pricing page reads the
 * same numbers the gate logic uses. Shape is intentionally credit-shaped
 * (no per-feature counters) — callers that want the prior translations/
 * explanations breakdown should derive it from `costs` × `total`.
 */
async function getUsageSnapshot(userId, tier, opts = {}) {
  return credits.getBalance(userId, tier || 'free', opts);
}

module.exports = {
  checkTranslation,
  checkBriefingAccess,
  getUsageSnapshot,
};
