/**
 * creditLedger.js — token/credit system for user-facing AI features
 *
 * Replaces the old per-feature hard caps (1/day article analysis,
 * 25/day keyword context, …) with a unified credit balance:
 *
 *   Weekly "base" credits (reset every Monday 00:00 UTC) — granted by tier.
 *   Rolling "add-on" credits (never expire) — granted by purchase.
 *
 * Each AI call deducts credits scaled to that call's actual Claude cost
 * (see CREDIT_COSTS below). One credit ≈ $0.001 of Claude spend, so the
 * tier allowances below translate directly to a weekly AI-cost budget
 * per user.
 *
 * Profit model (Pro = $5/mo):
 *   $5 subscription – $0.45 Stripe = $4.55 net
 *   400 credits/week × 4.33 weeks = 1732 credits/month = $1.73 AI cost
 *   Gross margin: ($4.55 - $1.73) / $5 = 56%
 */

'use strict';
const pool = require('./db');

// ─── Credit cost per call type ──────────────────────────────────────────────
// Scaled so 1 credit ≈ $0.001 of expected Claude cost. Re-measure and
// adjust when prompts grow. Budget 20% headroom above measured cost.
const CREDIT_COSTS = Object.freeze({
  article_analysis:  8,   // /api/explain  (Haiku: ~3K in + 900 out ≈ $0.008)
  keyword_context:   7,   // /api/keywords/explain (~$0.007)
  cluster_analysis: 13,   // /api/cluster-node/summary (~$0.013)
  flow_context:     10,   // /api/ai/flow-context (~$0.010)
  translate:         1,   // DeepL — nominal (real cost ~$0.0005)
});

// ─── Weekly base allowance by tier ──────────────────────────────────────────
// Tuned to profit targets at the $5/mo Pro price point. See creditLedger
// file header for the margin math. Enterprise weekly ≈ $2.50 in Claude,
// well within the $20/mo enterprise price. Free gets a taste (20 credits
// = roughly 2 article analyses per week).
const WEEKLY_BASE = Object.freeze({
  free:        20,
  pro:        400,
  enterprise: 2500,
});

function baseFor(tier) {
  return WEEKLY_BASE[tier] != null ? WEEKLY_BASE[tier] : WEEKLY_BASE.free;
}

// ─── Add-on packs (used by payment webhook / admin grant) ───────────────────
const ADDON_PACKS = Object.freeze({
  small:  { credits: 500,  priceUsd: 2.00 },   // $0.004/credit — 4× cost
  medium: { credits: 2000, priceUsd: 6.00 },   // $0.003/credit — 3× cost
});

// ─── Helpers ────────────────────────────────────────────────────────────────

// ISO week start (Monday) as a SQL date string, computed in UTC to match
// the DB default. Same math PG does with date_trunc('week', …).
function currentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay();           // 0 = Sunday … 6 = Saturday
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetToMonday
  ));
  return monday.toISOString().slice(0, 10);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Consume credits for a feature call. Atomic: balance row is locked,
 * spent first from base allowance then from add-on balance. If the user
 * doesn't have enough total credits, returns { allowed: false } without
 * touching the balance.
 *
 * @param {string} userId   Supabase user id
 * @param {string} tier     'free' | 'pro' | 'enterprise'
 * @param {string} feature  Key of CREDIT_COSTS (or a number for ad-hoc cost)
 * @param {object} [opts]
 * @param {string} [opts.referenceId]  Optional audit hint (article_id, etc.)
 * @returns {Promise<{ allowed: bool, cost: number, remaining: number,
 *                     base_remaining: number, addon_remaining: number,
 *                     weekly_limit: number, reason?: string }>}
 */
async function consumeCredits(userId, tier, feature, opts = {}) {
  if (!userId) return { allowed: false, cost: 0, remaining: 0, base_remaining: 0, addon_remaining: 0, weekly_limit: 0, reason: 'auth_required' };

  const cost = typeof feature === 'number' ? feature : CREDIT_COSTS[feature];
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error(`creditLedger.consumeCredits: unknown feature "${feature}"`);
  }
  const weeklyLimit = baseFor(tier);
  const weekStart   = currentWeekStart();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row (or create it on first touch).
    await client.query(`
      INSERT INTO user_credit_balance (user_id, base_credits_used, base_week_start, addon_credits)
      VALUES ($1, 0, $2, 0)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId, weekStart]);

    const { rows } = await client.query(`
      SELECT base_credits_used, base_week_start::text AS base_week_start,
             addon_credits, total_consumed
        FROM user_credit_balance
       WHERE user_id = $1
       FOR UPDATE
    `, [userId]);
    const row = rows[0];

    // Roll the week if necessary — when the current UTC week is later
    // than the stored base_week_start, reset base_credits_used and log
    // a refill event for auditability.
    let baseUsed     = Number(row.base_credits_used) || 0;
    let storedWeek   = row.base_week_start;
    let addonBalance = Number(row.addon_credits) || 0;
    if (storedWeek < weekStart) {
      baseUsed = 0;
      storedWeek = weekStart;
      await client.query(`
        UPDATE user_credit_balance
           SET base_credits_used = 0, base_week_start = $2, updated_at = NOW()
         WHERE user_id = $1
      `, [userId, weekStart]);
      await client.query(`
        INSERT INTO credit_ledger (user_id, delta, reason, balance_after)
        VALUES ($1, $2, 'refill.weekly', $3)
      `, [userId, weeklyLimit, weeklyLimit + addonBalance]);
    }

    const baseAvailable = Math.max(0, weeklyLimit - baseUsed);
    const totalAvail    = baseAvailable + addonBalance;

    if (totalAvail < cost) {
      await client.query('COMMIT');
      return {
        allowed:          false,
        cost,
        remaining:        totalAvail,
        base_remaining:   baseAvailable,
        addon_remaining:  addonBalance,
        weekly_limit:     weeklyLimit,
        reason:           'insufficient_credits',
      };
    }

    // Drain base first, then addon. Weekly-refresh feel: users always
    // consume fresh allotment before spending purchased credits.
    let fromBase  = Math.min(cost, baseAvailable);
    let fromAddon = cost - fromBase;

    await client.query(`
      UPDATE user_credit_balance
         SET base_credits_used = base_credits_used + $2,
             addon_credits     = addon_credits - $3,
             total_consumed    = total_consumed + $4,
             last_consumed_at  = NOW(),
             updated_at        = NOW()
       WHERE user_id = $1
    `, [userId, fromBase, fromAddon, cost]);

    const remainingBase  = baseAvailable - fromBase;
    const remainingAddon = addonBalance  - fromAddon;
    const remainingTotal = remainingBase + remainingAddon;

    await client.query(`
      INSERT INTO credit_ledger (user_id, delta, reason, reference_id, balance_after)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, -cost, `consume.${typeof feature === 'string' ? feature : 'custom'}`,
        opts.referenceId != null ? String(opts.referenceId) : null,
        remainingTotal]);

    await client.query('COMMIT');
    return {
      allowed:         true,
      cost,
      remaining:       remainingTotal,
      base_remaining:  remainingBase,
      addon_remaining: remainingAddon,
      weekly_limit:    weeklyLimit,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read balance without consuming. Used by the frontend to render the
 * credit meter and by endpoint handlers that want to show the user
 * what they'd spend on a click.
 */
async function getBalance(userId, tier) {
  if (!userId) {
    return {
      tier:            tier || 'free',
      weekly_limit:    baseFor(tier || 'free'),
      base_used:       0,
      base_remaining:  baseFor(tier || 'free'),
      addon_credits:   0,
      total:           baseFor(tier || 'free'),
      week_start:      currentWeekStart(),
    };
  }
  const weeklyLimit = baseFor(tier);
  const weekStart   = currentWeekStart();
  const { rows } = await pool.query(`
    SELECT base_credits_used, base_week_start::text AS base_week_start,
           addon_credits, total_consumed
      FROM user_credit_balance
     WHERE user_id = $1
  `, [userId]);
  const row = rows[0];
  const baseUsed     = row && row.base_week_start >= weekStart ? Number(row.base_credits_used) : 0;
  const addonCredits = row ? Number(row.addon_credits) : 0;
  const baseRemaining = Math.max(0, weeklyLimit - baseUsed);
  return {
    tier:            tier || 'free',
    weekly_limit:    weeklyLimit,
    base_used:       baseUsed,
    base_remaining:  baseRemaining,
    addon_credits:   addonCredits,
    total:           baseRemaining + addonCredits,
    week_start:      weekStart,
    costs:           CREDIT_COSTS,
  };
}

/**
 * Grant add-on credits (from a payment webhook or admin action).
 * `reason` should be e.g. 'purchase.small' or 'adjustment' for audit.
 */
async function grantAddonCredits(userId, credits, reason, referenceId = null) {
  if (!userId || !Number.isFinite(credits) || credits <= 0) {
    throw new Error('grantAddonCredits: invalid args');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO user_credit_balance (user_id, addon_credits, total_purchased)
      VALUES ($1, $2, $2)
      ON CONFLICT (user_id) DO UPDATE
        SET addon_credits   = user_credit_balance.addon_credits + EXCLUDED.addon_credits,
            total_purchased = user_credit_balance.total_purchased + EXCLUDED.addon_credits,
            updated_at      = NOW()
    `, [userId, credits]);
    const { rows } = await client.query(`
      SELECT addon_credits FROM user_credit_balance WHERE user_id = $1
    `, [userId]);
    await client.query(`
      INSERT INTO credit_ledger (user_id, delta, reason, reference_id, balance_after)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, credits, reason || 'purchase.manual', referenceId, rows[0]?.addon_credits ?? credits]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  CREDIT_COSTS,
  WEEKLY_BASE,
  ADDON_PACKS,
  consumeCredits,
  getBalance,
  grantAddonCredits,
  currentWeekStart,
};
