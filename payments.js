'use strict';

/**
 * payments.js — PayPal subscription management
 *
 * Exports:
 *   router — Express Router (mount with app.use('/api/payments', router))
 *
 * Required env vars:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_PLAN_ID_PRO         (from PayPal dashboard — $5/month)
 *   PAYPAL_PLAN_ID_ENTERPRISE  (from PayPal dashboard — $25/month)
 *   PAYPAL_ENV                 ('sandbox' or 'live', defaults to 'sandbox')
 *
 *   SUPABASE_URL               (your Supabase project URL)
 *   SUPABASE_SERVICE_ROLE_KEY  (from Supabase → Settings → API → service_role key)
 *                               ⚠️  Never expose this in the frontend — server-only
 */

const express = require('express');
const pool    = require('./db');

const sba = require('./supabaseAdmin');

const router = express.Router();

const PAYPAL_PLAN = {
  pro:        process.env.PAYPAL_PLAN_ID_PRO,
  enterprise: process.env.PAYPAL_PLAN_ID_ENTERPRISE,
};

function getPayPalEnv() {
  return process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
}

function getPayPalSdkBase() {
  return getPayPalEnv() === 'live'
    ? 'https://www.paypal.com'
    : 'https://www.sandbox.paypal.com';
}

// ─── Supabase helpers (subscriptions live in Supabase, not Render Postgres) ─

async function getTierIdByName(name) {
  const { data, error } = await sba
    .from('subscription_tiers')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (error) throw new Error(`getTierIdByName: ${error.message}`);
  if (!data?.id) throw new Error(`Missing subscription_tiers row for "${name}"`);
  return data?.id ?? null;
}

async function upsertSubscription({ userId, tier, provider, providerSubId, providerCusId, periodEnd, status = 'active' }) {
  const tierId = await getTierIdByName(tier);
  const payload = {
    user_id:            userId,
    tier_id:            tierId,
    provider,
    provider_sub_id:    providerSubId,
    provider_cus_id:    providerCusId,
    current_period_end: periodEnd?.toISOString() ?? null,
    status,
    updated_at:         new Date().toISOString(),
  };

  const { data: existing, error: existingError } = await sba
    .from('subscriptions')
    .select('user_id')
    .eq('user_id', userId)
    .limit(1);
  if (existingError) throw new Error(`loadSubscription: ${existingError.message}`);

  if (existing?.length) {
    const { error } = await sba
      .from('subscriptions')
      .update(payload)
      .eq('user_id', userId);
    if (error) throw new Error(`updateSubscription: ${error.message}`);
    return;
  }

  const { error } = await sba
    .from('subscriptions')
    .insert(payload);
  if (error) throw new Error(`insertSubscription: ${error.message}`);
}

async function cancelSubscription(userId) {
  const { error } = await sba
    .from('subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw new Error(`cancelSubscription: ${error.message}`);
}

async function setSubscriptionStatus(userId, status) {
  const { error } = await sba
    .from('subscriptions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw new Error(`setSubscriptionStatus: ${error.message}`);
}

async function getBestSubscriptionStatus(userId) {
  const { data, error } = await sba
    .from('subscriptions')
    .select('id, status, updated_at, provider, tier_id')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (error) throw new Error(`getSubscriptionStatus: ${error.message}`);

  const active = (data || []).sort((a, b) => {
    const tierA = Number(a?.tier_id) || 0;
    const tierB = Number(b?.tier_id) || 0;
    if (tierA !== tierB) return tierB - tierA;
    const updatedA = new Date(a?.updated_at || 0).getTime();
    const updatedB = new Date(b?.updated_at || 0).getTime();
    return updatedB - updatedA;
  })[0] || null;

  if (!active?.tier_id) {
    return {
      subscription_id: null,
      status: null,
      provider: null,
      tier_id: 1,
      tier_name: 'free',
      tier_display_name: 'Free',
      updated_at: null
    };
  }

  const { data: tier, error: tierError } = await sba
    .from('subscription_tiers')
    .select('id, name, display_name')
    .eq('id', active.tier_id)
    .maybeSingle();
  if (tierError) throw new Error(`getSubscriptionTier: ${tierError.message}`);

  return {
    subscription_id: active.id || null,
    status: active.status || null,
    provider: active.provider || null,
    tier_id: active.tier_id || null,
    tier_name: tier?.name || 'free',
    tier_display_name: tier?.display_name || 'Free',
    updated_at: active.updated_at || null
  };
}

// ─── PayPal access token ────────────────────────────────────────────────────
let _ppToken = null;
let _ppTokenExpiry = 0;

async function getPayPalToken() {
  if (_ppToken && Date.now() < _ppTokenExpiry - 60_000) return _ppToken;
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const base  = getPayPalEnv() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method:  'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token error ${res.status}`);
  const data = await res.json();
  _ppToken = data.access_token;
  _ppTokenExpiry = Date.now() + (data.expires_in * 1000);
  return _ppToken;
}

const PP_BASE = () => getPayPalEnv() === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

router.get('/paypal/config', (_req, res) => {
  const clientId = process.env.PAYPAL_CLIENT_ID || null;
  const planIdPro = PAYPAL_PLAN.pro || null;
  const planIdEnterprise = PAYPAL_PLAN.enterprise || null;

  if (!clientId || !planIdPro || !planIdEnterprise) {
    return res.status(503).json({
      error: 'PayPal configuration is incomplete',
      hasClientId: Boolean(clientId),
      hasPlanIdPro: Boolean(planIdPro),
      hasPlanIdEnterprise: Boolean(planIdEnterprise)
    });
  }

  return res.json({
    clientId,
    env: getPayPalEnv(),
    sdkBase: getPayPalSdkBase(),
    planIdPro,
    planIdEnterprise
  });
});

router.get('/subscription-status', requireAuth, async (req, res) => {
  try {
    const status = await getBestSubscriptionStatus(req.user.id);
    res.json(status);
  } catch (err) {
    console.error('[payments/subscription-status]', err.message);
    res.status(500).json({ error: 'Failed to load subscription status' });
  }
});

async function ppGet(path) {
  const tok = await getPayPalToken();
  const res = await fetch(`${PP_BASE()}${path}`, {
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`PayPal GET ${path} → ${res.status}`);
  return res.json();
}

function ppPlanToTier(planId) {
  if (planId === PAYPAL_PLAN.enterprise) return 'enterprise';
  if (planId === PAYPAL_PLAN.pro)        return 'pro';
  return null;
}

// ─── Auth middleware ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (req.user?.id) return next();

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { data, error } = await sba.auth.getUser(token);
    if (error || !data?.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = {
      ...(req.user || {}),
      id: data.user.id,
      email: data.user.email || null
    };
    return next();
  } catch (err) {
    console.error('[payments/auth]', err.message);
    return res.status(401).json({ error: 'Authentication required' });
  }
}

// ─── PayPal — Activate subscription after user approval ───────────────────
// PayPal's JS SDK handles the popup. After approval it returns a subscriptionID.
// Frontend POSTs it here to verify and record.
router.post('/paypal/activate', requireAuth, async (req, res) => {
  const { subscriptionId, tier } = req.body;
  if (!subscriptionId || !['pro', 'enterprise'].includes(tier)) {
    return res.status(400).json({ error: 'subscriptionId and tier required' });
  }

  try {
    const data = await ppGet(`/v1/billing/subscriptions/${subscriptionId}`);
    if (data.status !== 'ACTIVE') {
      return res.status(400).json({ error: `PayPal subscription not active (status: ${data.status})` });
    }

    const planId       = data.plan_id;
    const tierFromPlan = ppPlanToTier(planId);
    if (tierFromPlan !== tier) {
      return res.status(400).json({ error: 'Tier mismatch between plan and request' });
    }

    const periodEnd = data.billing_info?.next_billing_time
      ? new Date(data.billing_info.next_billing_time)
      : null;

    await upsertSubscription({
      userId:        req.user.id,
      tier,
      provider:      'paypal',
      providerSubId: subscriptionId,
      providerCusId: data.subscriber?.payer_id || null,
      periodEnd,
      status:        'active',
    });

    console.log(`[paypal] Activated subscription for user=${req.user.id} tier=${tier}`);
    res.json({ success: true, tier });
  } catch (err) {
    console.error('[payments/paypal/activate]', err.message);
    res.status(500).json({
      error: 'Failed to activate PayPal subscription',
      detail: err.message
    });
  }
});

// ─── PayPal — Webhook ─────────────────────────────────────────────────────
router.post('/paypal/webhook', async (req, res) => {
  const event     = req.body;
  const eventType = event?.event_type;
  const resource  = event?.resource || {};

  try {
    const subscriptionId = resource.id;
    if (!subscriptionId) { res.sendStatus(200); return; }

    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const periodEnd = resource.billing_info?.next_billing_time
        ? new Date(resource.billing_info.next_billing_time) : null;
      await sba.from('subscriptions')
        .update({ status: 'active', current_period_end: periodEnd?.toISOString() ?? null, updated_at: new Date().toISOString() })
        .eq('provider_sub_id', subscriptionId);

    } else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') {
      const { data } = await sba.from('subscriptions').select('user_id').eq('provider_sub_id', subscriptionId).maybeSingle();
      if (data?.user_id) await cancelSubscription(data.user_id);

    } else if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      const { data } = await sba.from('subscriptions').select('user_id').eq('provider_sub_id', subscriptionId).maybeSingle();
      if (data?.user_id) await setSubscriptionStatus(data.user_id, 'past_due');
    }
  } catch (err) {
    console.error('[paypal/webhook]', err.message);
  }

  res.sendStatus(200);
});

// ─── Usage snapshot ────────────────────────────────────────────────────────
router.get('/usage', requireAuth, async (req, res) => {
  const { getUsageSnapshot } = require('./tierLimits');
  try {
    const snap = await getUsageSnapshot(req.user.id, req.user.tier || 'free');
    res.json(snap);
  } catch (err) {
    console.error('[payments/usage]', err.message);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

module.exports = { router };
