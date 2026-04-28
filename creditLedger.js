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
 *   400 credits/week × 4.33 weeks = 1732 credits/month = $1.73 AI cost
 *
 *   Web (PayPal ~3.49% + $0.49):  $5 - $0.66 = $4.34 net → 52% margin
 *   iOS (Apple 30%):              $5 - $1.50 = $3.50 net → 35% margin
 *   iOS (Apple SBP 15%, year 2+): $5 - $0.75 = $4.25 net → 50% margin
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
  // /api/heatmap/ask — Claude tool-use call returning ~200 country
  // values. Slim prompt (~3K in including ISO catalog), structured output
  // (~600 out via tool schema). Switched to Sonnet 4.5 (3x Haiku cost) to
  // fix Haiku's tendency to over-include — see heatmap-test.js. Cache hits
  // + curated rows are FREE — credits only charged when we actually
  // invoke Claude. (~$0.025-0.030)
  heatmap_qa:       30,
  // /api/briefing/custom — most expensive feature in the app. Cost is
  // dominated by ElevenLabs TTS, which is OPT-IN (the `voiceover` flag).
  // We track two tiers because the cost spread is ~10×:
  //
  //   custom_briefing_text (NO voiceover):
  //     • Sonnet narrative (5K in + 3K out)            ≈ $0.06
  //     • 3 Haiku data panels (~3K each in/out)        ≈ $0.02
  //     • optional heatmap pre-resolution              ≈ $0.05
  //     • storage I/O                                  ≈ $0.01
  //     Sum: ~$0.10–0.15. 200 credits = ~$0.20 with ~30% headroom.
  //
  //   custom_briefing_voice (WITH voiceover):
  //     • Everything in custom_briefing_text           ≈ $0.15
  //     • ElevenLabs eleven_multilingual_v2:
  //         ~750 words × 5.5 chars = ~4,500 chars typical, up to
  //         ~8,000 chars on a verbose briefing. At Pro-plan pricing
  //         (~$0.000198/char) that's $0.89–1.58.
  //     Sum: ~$1.05–1.75. 1500 credits = ~$1.50 budget — undercharges
  //     by ~$0.25 on the worst-case verbose run, profitable at the
  //     median (~$1.20). Bump to 1800 if cost monitoring shows the
  //     average climbing past $1.40.
  //
  // Enterprise weekly base = 2500 credits, so a user can run:
  //   • ~1 voiceover briefing per week + ~5 text-only, or
  //   • ~12 text-only briefings per week.
  // Plus add-on packs for heavier use. Free/Pro can't afford either
  // tier even once and the endpoint gates on tier === 'enterprise'
  // before the credit check anyway.
  //
  // Endpoint code at /api/briefing/custom picks the right key based
  // on req.body.voiceover.
  custom_briefing_text:  200,
  custom_briefing_voice: 1500,
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

  // Admin bypass: admins pay no credits and the response advertises an
  // infinite weekly limit so the frontend meter renders ∞ instead of a
  // decreasing bar. Ledger entries are NOT written for admin usage — this
  // keeps the `total_consumed` counter honest as a real-user metric.
  if (opts.isAdmin) {
    return {
      allowed:         true,
      cost:            0,
      remaining:       Infinity,
      base_remaining:  Infinity,
      addon_remaining: 0,
      weekly_limit:    Infinity,
      admin:           true,
    };
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
async function getBalance(userId, tier, { isAdmin = false } = {}) {
  // Admins get a sentinel "∞" balance so the frontend renders it as
  // unlimited without special-casing per caller.
  if (isAdmin) {
    return {
      tier:            'admin',
      weekly_limit:    Infinity,
      base_used:       0,
      base_remaining:  Infinity,
      addon_credits:   0,
      total:           Infinity,
      week_start:      currentWeekStart(),
      costs:           CREDIT_COSTS,
      admin:           true,
    };
  }
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

/**
 * Refund credits previously consumed by a feature call. Used when a
 * call is debited atomically up front but then fails mid-flight (e.g.
 * the briefing generator throws after we already deducted the cost).
 *
 * Reverses the consumeCredits draining order: refunds to base_credits_used
 * first (up to whatever was consumed this week), then to addon_credits.
 * That keeps the user whole if the same week's allowance was where the
 * debit came from. Best-effort — silent no-op for admin (they paid 0
 * credits in the first place) or unknown user.
 *
 * @param {string} userId   Supabase user id
 * @param {number} amount   Credits to refund (must match the original cost)
 * @param {string} feature  Key of CREDIT_COSTS or 'custom' label for ledger
 * @param {object} [opts]
 * @param {string} [opts.reason]        e.g. 'generation_failed'
 * @param {string} [opts.errorMessage]  Stamped into the ledger row for audit
 * @returns {Promise<{ok: bool, refunded: number}>}
 */
async function refundCredits(userId, amount, feature, opts = {}) {
  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, refunded: 0 };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the balance row.
    const { rows } = await client.query(`
      SELECT base_credits_used, addon_credits
        FROM user_credit_balance
       WHERE user_id = $1
       FOR UPDATE
    `, [userId]);
    if (!rows.length) {
      // Nothing was ever consumed (admin or untouched user) — no-op.
      await client.query('COMMIT');
      return { ok: true, refunded: 0 };
    }
    const baseUsed = Number(rows[0].base_credits_used) || 0;
    // Refund order: base first (uncharge what was charged), then addon.
    const toBase  = Math.min(amount, baseUsed);
    const toAddon = amount - toBase;
    await client.query(`
      UPDATE user_credit_balance
         SET base_credits_used = GREATEST(0, base_credits_used - $2),
             addon_credits     = addon_credits + $3,
             total_consumed    = GREATEST(0, total_consumed - $4),
             updated_at        = NOW()
       WHERE user_id = $1
    `, [userId, toBase, toAddon, amount]);
    await client.query(`
      INSERT INTO credit_ledger (user_id, delta, reason, reference_id, balance_after)
      SELECT $1, $2, $3, $4,
             (SELECT (base_credits_used * -1) + addon_credits FROM user_credit_balance WHERE user_id = $1)
    `, [
      userId,
      amount,
      `refund.${feature || 'unknown'}${opts.reason ? '.' + opts.reason : ''}`,
      opts.errorMessage ? String(opts.errorMessage).slice(0, 240) : null,
    ]);
    await client.query('COMMIT');
    return { ok: true, refunded: amount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { ok: false, refunded: 0, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  CREDIT_COSTS,
  WEEKLY_BASE,
  ADDON_PACKS,
  consumeCredits,
  refundCredits,
  getBalance,
  grantAddonCredits,
  currentWeekStart,
};
