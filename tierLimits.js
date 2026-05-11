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
 * Episode-scoped briefing access gate. Honors the briefing funnel:
 *   - re-listens of an already-accessed episode → free (idempotent)
 *   - admins + pro/enterprise tiers → free (no credit charge)
 *   - free tier within 7 days of FIRST listen → free 7-day trial
 *   - free tier post-trial → 1 free briefing per ISO week
 *   - free tier post-trial, second+ briefing this week → 403 paywall
 *
 * Trial anchor is the MIN(accessed_at) from briefing_access_log for the
 * user. We don't read auth.users.created_at because the auth schema
 * isn't always reachable from the app's PG role, and "first listen"
 * gives a more forgiving definition of trial start (user who installs
 * but doesn't listen for two weeks then taps Begin still gets the full
 * trial).
 *
 * `briefing_access_log` is the source of truth for both "has this user
 * already paid for this episode" (PK is user_id+episode_id) and the
 * trial/weekly counters (via accessed_at).
 */
const TRIAL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days
const WEEK_MS     = 7 * 24 * 60 * 60 * 1000; // also 7 days; named for clarity

async function checkBriefingAccess(userId, episodeId, tier, opts = {}) {
  if (!userId) return { allowed: true };

  // Re-listen check — idempotent on (user_id, episode_id).
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM briefing_access_log WHERE user_id = $1 AND episode_id = $2`,
    [userId, episodeId]
  );
  if (existing.length) return { allowed: true };

  const isPaid  = (tier === 'pro' || tier === 'enterprise' || opts.isAdmin === true);
  const isAdmin = opts.isAdmin === true;

  // Pro / Enterprise / Admin → free listen (no credit charge, no trial
  // accounting). They're not on the funnel; just log + allow.
  if (isPaid) {
    await pool.query(
      `INSERT INTO briefing_access_log (user_id, episode_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, episodeId]
    );
    return isAdmin
      ? { allowed: true, used: 0, limit: Infinity }
      : { allowed: true, used: 0, limit: Infinity };
  }

  // Free tier — trial + weekly logic.
  //
  // Single query fetches the trial anchor (MIN accessed_at). Trial state
  // is computed in JS from that. The post-trial weekly counter requires
  // a second focused query that excludes ANY listens that fell inside
  // the trial window — otherwise a user who listened daily during the
  // trial would be locked out for a week after the trial ends (the 7
  // trial listens would count against their first post-trial week).
  const { rows: anchorRow } = await pool.query(
    `SELECT MIN(accessed_at) AS first_listen FROM briefing_access_log WHERE user_id = $1`,
    [userId]
  );
  const firstListen = anchorRow[0]?.first_listen;

  let allowed = false;
  let phase   = 'pre-trial';
  if (!firstListen) {
    // Truly first listen → trial starts here.
    allowed = true;
    phase   = 'trial-start';
  } else {
    const anchorMs   = new Date(firstListen).getTime();
    const trialEndMs = anchorMs + TRIAL_MS;
    const inTrial    = Date.now() < trialEndMs;
    if (inTrial) {
      allowed = true;
      phase   = 'trial-active';
    } else {
      // Post-trial — count listens IN THE LAST 7 DAYS that also fell
      // AFTER trial-end. GREATEST() picks the more-recent of the two
      // cutoffs so a user who never listened post-trial sees 0 even
      // if their first weeks contained 7 trial listens.
      const trialEndIso = new Date(trialEndMs).toISOString();
      const { rows: cntRows } = await pool.query(
        `SELECT COUNT(*) AS cnt
           FROM briefing_access_log
          WHERE user_id = $1
            AND accessed_at >= GREATEST($2::timestamptz, NOW() - INTERVAL '7 days')`,
        [userId, trialEndIso]
      );
      const postTrialWeeklyCount = Number(cntRows[0]?.cnt || 0);
      allowed = postTrialWeeklyCount < 1;
      phase   = allowed ? 'weekly-fresh' : 'weekly-used';
    }
  }

  if (!allowed) {
    // Refusal payload mirrors the credit-shortfall shape for frontend
    // 403 handlers, but flags it as a tier limit (used >= limit) so
    // the UI shows "Pro for daily" instead of "out of credits."
    return {
      allowed:   false,
      used:      1,
      limit:     1,
      resetNote: 'Weekly briefing used — upgrade to Pro for daily',
      requiredTier: 'pro',
      phase,
    };
  }

  // Log the access. No credit charge for free-tier briefings under the
  // new scheme — briefings are the loss-leader / acquisition channel,
  // not a per-listen credit drain. (Reverts the prior 10-credit cost
  // which was eating Free-tier weekly allowances.)
  await pool.query(
    `INSERT INTO briefing_access_log (user_id, episode_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, episodeId]
  );
  return { allowed: true, used: 0, limit: Infinity, phase };
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
