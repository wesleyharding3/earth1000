'use strict';

/**
 * payments.js — PayPal + Apple StoreKit + RevenueCat subscription management
 *
 * Exports:
 *   router — Express Router (mount with app.use('/api/payments', router))
 *
 * Subscription routing:
 *   Web browsers → PayPal (handled directly, /paypal/* endpoints)
 *   iOS app      → RevenueCat → Apple StoreKit (RevenueCat webhooks fire
 *                  /revenuecat/webhook). The /apple/* endpoints exist as a
 *                  defense-in-depth fallback that validates a raw Apple
 *                  receipt directly with the JWS verifier.
 *
 * Required env vars:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_PLAN_ID_PRO         (from PayPal dashboard — $5/month)
 *   PAYPAL_PLAN_ID_ENTERPRISE  (from PayPal dashboard — $25/month)
 *   PAYPAL_ENV                 ('sandbox' or 'live', defaults to 'sandbox')
 *   PAYPAL_WEBHOOK_ID          (per-environment id from PayPal Dashboard →
 *                               Apps & Credentials → your app → Webhooks.
 *                               REQUIRED in production. If unset, /paypal/webhook
 *                               accepts unverified events with a logged warning;
 *                               this is intentional for sandbox dev before the
 *                               webhook is wired up, but a forged-event hole.)
 *
 *   APPLE_BUNDLE_ID            (e.g. com.earth00.app — must match capacitor.config.json)
 *   APPLE_PRODUCT_ID_PRO       (App Store Connect subscription product id, e.g. earth00.pro.monthly)
 *   APPLE_PRODUCT_ID_ENTERPRISE(App Store Connect subscription product id, e.g. earth00.enterprise.monthly)
 *   APPLE_ENV                  ('sandbox' or 'production', defaults to 'sandbox')
 *   APPLE_APP_APPLE_ID         (numeric Apple ID from App Store Connect, REQUIRED in production)
 *   APPLE_ROOT_CERTS_DIR       (absolute path to dir holding Apple root CAs;
 *                               defaults to ./apple-certs relative to this file)
 *
 *   REVENUECAT_PUBLIC_API_KEY_IOS  (public iOS SDK key — safe to ship in client)
 *   REVENUECAT_WEBHOOK_SECRET      (random string; set the same value in
 *                                   RevenueCat dashboard → Webhooks →
 *                                   "Authorization header value")
 *
 *   SUPABASE_URL               (your Supabase project URL)
 *   SUPABASE_SERVICE_ROLE_KEY  (from Supabase → Settings → API → service_role key)
 *                               ⚠️  Never expose this in the frontend — server-only
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const pool    = require('./db');

const sba = require('./supabaseAdmin');
const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');

const router = express.Router();

const PAYPAL_PLAN = {
  pro:        process.env.PAYPAL_PLAN_ID_PRO,
  enterprise: process.env.PAYPAL_PLAN_ID_ENTERPRISE,
};

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.earth00.app';
const APPLE_PRODUCT = {
  pro:        process.env.APPLE_PRODUCT_ID_PRO,
  enterprise: process.env.APPLE_PRODUCT_ID_ENTERPRISE,
};
function getAppleEnv() {
  return process.env.APPLE_ENV === 'production' ? 'production' : 'sandbox';
}
function appleProductToTier(productId) {
  if (productId === APPLE_PRODUCT.enterprise) return 'enterprise';
  if (productId === APPLE_PRODUCT.pro)        return 'pro';
  return null;
}

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

// Tier rank for downgrade-protection. Higher = better. Anything not in
// this map is treated as rank 0 so a degenerate / unknown tier from a
// stray webhook can never beat a real tier.
const TIER_RANK = { free: 1, pro: 2, enterprise: 3 };
function _tierRank(name) { return TIER_RANK[String(name || '').toLowerCase()] || 0; }

async function upsertSubscription({ userId, tier, provider, providerSubId, providerCusId, periodEnd, status = 'active' }) {
  const tierId = await getTierIdByName(tier);

  // ── Downgrade protection ─────────────────────────────────────────────
  // Sandbox (and occasionally production) Apple/RevenueCat fires multiple
  // webhooks during an upgrade — both the OLD product's RENEWAL/PRODUCT_
  // CHANGE and the NEW product's events arrive within seconds. With a
  // blind UPSERT the LAST writer wins, which can flip an enterprise row
  // back down to pro just because the pro renewal arrived a few hundred
  // ms after the enterprise upgrade. We observed this with the sandbox
  // log line:
  //   [revenuecat/webhook] type=PRODUCT_CHANGE product=earth00.pro.monthly tier=pro
  //   ↑ written AFTER an earlier enterprise upgrade had landed
  //
  // Guard: read the current row first; if the incoming tier is LOWER and
  // the row's status is still active and unexpired, no-op. Does NOT block
  // status changes (cancellation, expiration) — only refuses to silently
  // demote the tier_id of a still-active row.
  if (status === 'active') {
    const { data: existing } = await sba
      .from('subscriptions')
      .select('tier_id, status, current_period_end')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing?.tier_id != null && existing.status === 'active') {
      // Compare tier ranks via name (existing.tier_id → name).
      const existingTierName = await _tierNameById(existing.tier_id);
      const incomingRank = _tierRank(tier);
      const existingRank = _tierRank(existingTierName);
      const periodActive = !existing.current_period_end
        || new Date(existing.current_period_end) > new Date();
      if (incomingRank > 0 && incomingRank < existingRank && periodActive) {
        console.log(`[upsertSubscription] skipping downgrade: ${existingTierName}(rank ${existingRank}) → ${tier}(rank ${incomingRank}) for user ${userId}`);
        return;
      }
    }
  }

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

  // Atomic upsert — a previous SELECT-then-INSERT/UPDATE here let two
  // concurrent webhook deliveries for the same user both observe "no row"
  // and both INSERT, violating the one-row-per-user model. Requires the
  // UNIQUE constraint on subscriptions.user_id added by
  // migrations/20260501_subscriptions_user_id_unique.sql.
  const { error } = await sba
    .from('subscriptions')
    .upsert(payload, { onConflict: 'user_id' });
  if (error) throw new Error(`upsertSubscription: ${error.message}`);
}

// Reverse lookup for the downgrade guard. Cached for the process lifetime
// since the subscription_tiers table is small and never changes at runtime.
const _tierNameByIdCache = new Map();
async function _tierNameById(id) {
  if (_tierNameByIdCache.has(id)) return _tierNameByIdCache.get(id);
  const { data } = await sba
    .from('subscription_tiers')
    .select('name')
    .eq('id', id)
    .maybeSingle();
  const name = data?.name || null;
  if (name) _tierNameByIdCache.set(id, name);
  return name;
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
  // Two pieces of state are returned so the frontend can resolve access
  // with a single round-trip: (1) the active subscription + tier, (2) the
  // is_admin flag from profiles (already resolved by optionalAuth). If
  // the subscription lookup throws — missing table, RLS, network — we
  // degrade to a synthetic free-tier record and keep is_admin intact so
  // admins are never blocked by transient DB failures. Error details
  // surface only to admins, never to ordinary clients.
  const isAdmin = req.user?.is_admin === true;
  try {
    const status = await getBestSubscriptionStatus(req.user.id);
    res.json({ ...status, is_admin: isAdmin });
  } catch (err) {
    console.error('[payments/subscription-status]', err.message);
    const fallback = {
      subscription_id:   null,
      status:            null,
      provider:          null,
      tier_id:           isAdmin ? null : 1,
      tier_name:         'free',
      tier_display_name: 'Free',
      updated_at:        null,
      is_admin:          isAdmin,
      degraded:          true,
    };
    if (isAdmin) fallback.error_detail = err.message;
    res.status(200).json(fallback);
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

// ─── Webhook idempotency + audit log ──────────────────────────────────────
// Provider-agnostic dedupe gate. Every payment-provider webhook handler
// runs the incoming event through `recordWebhookEvent` first; the
// composite UNIQUE (provider, event_id) constraint on webhook_events
// makes a second delivery of the same event a no-op INSERT and we
// short-circuit. The handler then runs its side effects and calls
// `markWebhookProcessed` (success) or `markWebhookFailed` (error) so
// the row carries a full audit trail.
//
// Event-id sources:
//   • Apple:      notification.notificationUUID (RFC 4122 UUID, unique
//                 per delivery; redelivery uses the same value).
//   • PayPal:     event.id  (PayPal's webhook event id, opaque string).
//   • RevenueCat: event.id  (RC's per-event id; falls back to
//                 transaction_id if id is absent in older payloads).
//
// Returns:
//   { firstDelivery: true,  rowId: <int> }  — process the event
//   { firstDelivery: false, rowId: <int> }  — duplicate, skip processing
//   { firstDelivery: false, rowId: null   } — DB error, do NOT short-
//                                             circuit; the handler
//                                             should still try its
//                                             side effects (failing
//                                             open is safer than
//                                             losing legitimate
//                                             events when the audit
//                                             table itself is sick).
async function recordWebhookEvent({ provider, eventId, eventType, userId, payload }) {
  if (!provider || !eventId) {
    // Caller didn't get the event id from the payload — don't dedupe.
    // We still log the attempt with a synthetic id so the audit trail
    // captures malformed events, but they won't dedupe each other.
    return { firstDelivery: true, rowId: null };
  }
  try {
    const r = await pool.query(`
      INSERT INTO webhook_events (provider, event_id, event_type, user_id, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING id
    `, [provider, String(eventId), eventType || null, userId || null, JSON.stringify(payload || {})]);
    if (r.rows.length) {
      return { firstDelivery: true, rowId: r.rows[0].id };
    }
    // ON CONFLICT swallowed the insert — duplicate delivery.
    const existing = await pool.query(
      `SELECT id FROM webhook_events WHERE provider = $1 AND event_id = $2`,
      [provider, String(eventId)]
    );
    return { firstDelivery: false, rowId: existing.rows[0]?.id || null };
  } catch (err) {
    // DB sick — caller should still process so we don't lose
    // legitimate events while the audit table is unreachable.
    console.error('[webhook-log] insert failed:', err.message);
    return { firstDelivery: true, rowId: null };
  }
}

async function markWebhookProcessed(rowId, userId) {
  if (!rowId) return;
  try {
    await pool.query(`
      UPDATE webhook_events
         SET processed_at     = NOW(),
             processing_error = NULL,
             user_id          = COALESCE($2, user_id)
       WHERE id = $1
    `, [rowId, userId || null]);
  } catch (err) {
    console.error('[webhook-log] mark-processed failed:', err.message);
  }
}

async function markWebhookFailed(rowId, errMessage) {
  if (!rowId) return;
  try {
    await pool.query(`
      UPDATE webhook_events
         SET processing_error = $2
       WHERE id = $1
    `, [rowId, String(errMessage || 'unknown error').slice(0, 4000)]);
  } catch (err) {
    console.error('[webhook-log] mark-failed failed:', err.message);
  }
}

// ─── PayPal webhook signature verification ────────────────────────────────
// PayPal signs every webhook delivery (sandbox + live). Verification calls
// PayPal's /v1/notifications/verify-webhook-signature with the original
// transmission headers + parsed body + the per-environment webhook id from
// the dashboard. Returns true only on { verification_status: "SUCCESS" }.
//
// If PAYPAL_WEBHOOK_ID is unset, we log a loud warning and accept the
// request — convenient for sandbox before the webhook subscription is
// wired up, dangerous in production. Set the env var before going live.
async function verifyPayPalWebhookSignature(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('[paypal/webhook] PAYPAL_WEBHOOK_ID not set — accepting unverified event. Set this env var before production.');
    return true;
  }
  const h = req.headers;
  const transmissionId   = h['paypal-transmission-id'];
  const transmissionTime = h['paypal-transmission-time'];
  const transmissionSig  = h['paypal-transmission-sig'];
  const certUrl          = h['paypal-cert-url'];
  const authAlgo         = h['paypal-auth-algo'];
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    console.warn('[paypal/webhook] missing transmission headers — rejecting');
    return false;
  }
  // PayPal recommends rejecting cert URLs that aren't on paypal.com to
  // prevent the verifier from being pointed at an attacker-controlled host
  // (the verify API does its own check too, but defense in depth is cheap).
  try {
    const u = new URL(certUrl);
    if (!/(^|\.)paypal\.com$/i.test(u.hostname)) {
      console.warn('[paypal/webhook] cert_url not on paypal.com:', certUrl);
      return false;
    }
  } catch (_) {
    console.warn('[paypal/webhook] cert_url not a valid URL:', certUrl);
    return false;
  }
  try {
    const token = await getPayPalToken();
    const r = await fetch(`${PP_BASE()}/v1/notifications/verify-webhook-signature`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo:         authAlgo,
        cert_url:          certUrl,
        transmission_id:   transmissionId,
        transmission_sig:  transmissionSig,
        transmission_time: transmissionTime,
        webhook_id:        webhookId,
        webhook_event:     req.body,
      }),
    });
    if (!r.ok) {
      console.warn(`[paypal/webhook] verify API returned ${r.status}`);
      return false;
    }
    const data = await r.json();
    return data?.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[paypal/webhook] verification error:', err.message);
    return false;
  }
}

// ─── PayPal — Webhook ─────────────────────────────────────────────────────
router.post('/paypal/webhook', async (req, res) => {
  // Verify signature BEFORE touching any state. Forged events must never
  // reach the idempotency log or modify subscriptions.
  const verified = await verifyPayPalWebhookSignature(req);
  if (!verified) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event     = req.body;
  const eventType = event?.event_type;
  const resource  = event?.resource || {};
  const eventId   = event?.id;
  const subscriptionId = resource.id;

  // Idempotency: dedupe re-deliveries of the same PayPal event id.
  const log = await recordWebhookEvent({
    provider:  'paypal',
    eventId,
    eventType,
    payload:   event,
  });
  if (!log.firstDelivery && log.rowId) {
    // Duplicate — already processed. ACK fast.
    return res.sendStatus(200);
  }

  if (!subscriptionId) {
    await markWebhookProcessed(log.rowId);
    return res.sendStatus(200);
  }

  try {
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
    await markWebhookProcessed(log.rowId);
  } catch (err) {
    console.error('[paypal/webhook]', err.message);
    await markWebhookFailed(log.rowId, err.message);
    // Return 5xx so PayPal retries. Previously this returned 200 even
    // on processing error → PayPal treated it as ACK and never retried,
    // permanently losing the event. PayPal's retry policy is up to 25
    // attempts over 3 days; a transient DB hiccup is now recoverable.
    return res.sendStatus(500);
  }

  res.sendStatus(200);
});

// ─── Apple StoreKit / In-App Purchase ─────────────────────────────────────
//
// Flow:
//   1. iOS app fetches /apple/config to discover product ids + bundle id.
//   2. User taps "Subscribe via Apple". The Capacitor IAP plugin
//      (@capgo/capacitor-purchases) opens the native StoreKit sheet. On
//      success the plugin returns a signed JWS transaction (JWSTransaction
//      in StoreKit 2).
//   3. App POSTs that JWS to /apple/activate. Server verifies the JWS
//      signature against Apple's root CA, validates bundleId + productId +
//      expiresDate, and writes a row to Supabase `subscriptions`.
//   4. Apple sends server-to-server notifications (App Store Server
//      Notifications V2) to /apple/webhook for renew/expire/refund. We
//      verify+decode the signedPayload and update Supabase accordingly.
//
// JWS signatures are verified with `@apple/app-store-server-library` using
// the Apple root CAs in ./apple-certs/. The verifier checks the certificate
// chain, expiry, and (when enableOnlineChecks=true) revocation status.
// In production, APPLE_APP_APPLE_ID must be set so the verifier can match
// the appAppleId claim inside the JWS.

let _appleVerifier = null;
function getAppleVerifier() {
  if (_appleVerifier) return _appleVerifier;

  const certsDir = process.env.APPLE_ROOT_CERTS_DIR
    ? path.resolve(process.env.APPLE_ROOT_CERTS_DIR)
    : path.join(__dirname, 'apple-certs');

  if (!fs.existsSync(certsDir)) {
    throw new Error(`Apple root cert dir not found: ${certsDir}`);
  }

  const rootCerts = fs.readdirSync(certsDir)
    .filter(f => /\.(cer|crt|der)$/i.test(f))
    .map(f => fs.readFileSync(path.join(certsDir, f)));

  if (!rootCerts.length) {
    throw new Error(`No Apple root certs (*.cer/*.crt/*.der) in ${certsDir}`);
  }

  const env = getAppleEnv() === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
  const appAppleId = process.env.APPLE_APP_APPLE_ID
    ? Number(process.env.APPLE_APP_APPLE_ID)
    : undefined;

  if (env === Environment.PRODUCTION && !Number.isFinite(appAppleId)) {
    throw new Error('APPLE_APP_APPLE_ID is required for production environment');
  }

  // enableOnlineChecks: revocation + expiry against current time. Set false
  // only in tests where you replay frozen receipts past their expiry.
  _appleVerifier = new SignedDataVerifier(
    rootCerts,
    true,
    env,
    APPLE_BUNDLE_ID,
    appAppleId
  );
  return _appleVerifier;
}

router.get('/apple/config', (_req, res) => {
  if (!APPLE_BUNDLE_ID || !APPLE_PRODUCT.pro || !APPLE_PRODUCT.enterprise) {
    return res.status(503).json({
      error: 'Apple IAP configuration is incomplete',
      hasBundleId:           Boolean(APPLE_BUNDLE_ID),
      hasProductIdPro:       Boolean(APPLE_PRODUCT.pro),
      hasProductIdEnterprise:Boolean(APPLE_PRODUCT.enterprise),
    });
  }
  res.json({
    bundleId:               APPLE_BUNDLE_ID,
    env:                    getAppleEnv(),
    productIdPro:           APPLE_PRODUCT.pro,
    productIdEnterprise:    APPLE_PRODUCT.enterprise,
  });
});

// Called by the iOS client immediately after a successful StoreKit purchase.
// Body: { signedTransaction: "<JWS string from StoreKit 2>", tier: "pro"|"enterprise" }
router.post('/apple/activate', requireAuth, async (req, res) => {
  const { signedTransaction, tier } = req.body || {};
  if (!signedTransaction || !['pro', 'enterprise'].includes(tier)) {
    return res.status(400).json({ error: 'signedTransaction and tier required' });
  }

  let tx;
  try {
    // verifyAndDecodeTransaction validates the full cert chain against
    // Apple's root CA, checks the JWS signature, verifies bundleId matches
    // the verifier's bundleId, and (in production) verifies appAppleId.
    // Throws VerificationException on any failure.
    tx = await getAppleVerifier().verifyAndDecodeTransaction(signedTransaction);
  } catch (err) {
    console.warn('[apple/activate] JWS verification failed:', err.message);
    return res.status(400).json({ error: 'Apple receipt verification failed', detail: err.message });
  }

  try {
    const tierFromProduct = appleProductToTier(tx.productId);
    if (!tierFromProduct) {
      return res.status(400).json({ error: `Unknown productId: ${tx.productId}` });
    }
    if (tierFromProduct !== tier) {
      return res.status(400).json({ error: 'Tier mismatch between product and request' });
    }

    // expiresDate is ms since epoch in StoreKit 2 JWS
    const periodEnd = tx.expiresDate ? new Date(Number(tx.expiresDate)) : null;
    if (periodEnd && periodEnd.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Transaction already expired' });
    }

    await upsertSubscription({
      userId:        req.user.id,
      tier,
      provider:      'apple',
      // originalTransactionId is stable across renewals — perfect provider_sub_id
      providerSubId: String(tx.originalTransactionId || tx.transactionId),
      // appAccountToken lets us tie a StoreKit purchase to our user (set this
      // on the iOS side when calling Product.purchase). Optional but useful.
      providerCusId: tx.appAccountToken || null,
      periodEnd,
      status:        'active',
    });

    console.log(`[apple] Activated subscription user=${req.user.id} tier=${tier} env=${getAppleEnv()}`);
    res.json({ success: true, tier });
  } catch (err) {
    console.error('[payments/apple/activate]', err.message);
    res.status(500).json({
      error: 'Failed to activate Apple subscription',
      detail: err.message,
    });
  }
});

// App Store Server Notifications V2 webhook.
// Configure URL in App Store Connect → App → App Information → App Store
// Server Notifications. Apple POSTs: { signedPayload: "<JWS>" }
//
// Both the outer notification and the inner signedTransactionInfo are
// verified end-to-end against Apple's root CA. Any failure → 200 with no
// state change (prevents Apple's retry storm but keeps us out of a bad
// state from a forged payload).
router.post('/apple/webhook', async (req, res) => {
  let logRowId = null;
  try {
    const { signedPayload } = req.body || {};
    if (!signedPayload) { res.sendStatus(200); return; }

    const verifier = getAppleVerifier();

    let notification;
    try {
      notification = await verifier.verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      console.warn('[apple/webhook] notification verification failed:', err.message);
      // Verification failure isn't a transient error — Apple's signature
      // either matches or doesn't. ACK so they don't retry forever.
      res.sendStatus(200);
      return;
    }

    const { notificationType, subtype, data, notificationUUID } = notification || {};

    // Idempotency: notificationUUID is Apple's per-delivery unique id.
    // A re-delivery of the same notification carries the same UUID, so
    // the unique constraint on (provider, event_id) catches it. Log the
    // verified+decoded notification, not the raw signedPayload — the
    // signature has already been checked, what matters is the data.
    const log = await recordWebhookEvent({
      provider:   'apple',
      eventId:    notificationUUID,
      eventType:  `${notificationType}${subtype ? '/' + subtype : ''}`,
      payload:    notification,
    });
    logRowId = log.rowId;
    if (!log.firstDelivery && log.rowId) {
      // Already processed this notification once — ACK fast.
      return res.sendStatus(200);
    }

    if (!data?.signedTransactionInfo) {
      await markWebhookProcessed(logRowId);
      res.sendStatus(200);
      return;
    }

    let tx;
    try {
      tx = await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
    } catch (err) {
      console.warn('[apple/webhook] transaction verification failed:', err.message);
      await markWebhookFailed(logRowId, `tx verify: ${err.message}`);
      res.sendStatus(200);
      return;
    }

    const originalTransactionId = String(tx.originalTransactionId || tx.transactionId || '');
    const tier = appleProductToTier(tx.productId);

    // Look up which user this subscription belongs to (recorded by /apple/activate)
    const { data: row } = await sba
      .from('subscriptions')
      .select('user_id')
      .eq('provider_sub_id', originalTransactionId)
      .maybeSingle();
    const userId = row?.user_id || null;

    console.log(`[apple/webhook] type=${notificationType} subtype=${subtype || '-'} user=${userId || '?'} tx=${originalTransactionId}`);

    if (!userId) {
      // Unrecognized originalTransactionId — likely a webhook for a
      // subscription that was never activated against this server (or
      // was already deleted via account deletion). Mark processed
      // (we're not going to learn more by retrying).
      await markWebhookProcessed(logRowId);
      res.sendStatus(200);
      return;
    }

    switch (notificationType) {
      case 'SUBSCRIBED':
      case 'DID_RENEW':
      case 'DID_CHANGE_RENEWAL_STATUS':
      case 'OFFER_REDEEMED': {
        if (tier) {
          await upsertSubscription({
            userId,
            tier,
            provider:      'apple',
            providerSubId: originalTransactionId,
            providerCusId: tx.appAccountToken || null,
            periodEnd:     tx.expiresDate ? new Date(Number(tx.expiresDate)) : null,
            status:        'active',
          });
        }
        break;
      }
      case 'DID_FAIL_TO_RENEW':
      case 'GRACE_PERIOD_EXPIRED':
        await setSubscriptionStatus(userId, 'past_due');
        break;
      case 'EXPIRED':
      case 'REVOKE':
      case 'REFUND':
      case 'REFUND_DECLINED':
        await cancelSubscription(userId);
        break;
      default:
        // Unhandled types: CONSUMPTION_REQUEST, PRICE_INCREASE, RENEWAL_EXTENDED, etc.
        break;
    }
    await markWebhookProcessed(logRowId, userId);
  } catch (err) {
    console.error('[apple/webhook]', err.message);
    await markWebhookFailed(logRowId, err.message);
    // Apple's App Store Server Notifications V2 retry policy: when the
    // server responds with a non-2xx, Apple re-sends with exponential
    // backoff for ~3 days before giving up. Returning 5xx here lets
    // transient DB / Supabase outages recover instead of permanently
    // losing the event.
    return res.sendStatus(500);
  }

  res.sendStatus(200);
});

// ─── RevenueCat ────────────────────────────────────────────────────────────
//
// RevenueCat is the iOS purchase intermediary: it wraps StoreKit on the
// device and validates Apple receipts on its servers. We never see the raw
// JWS — RevenueCat sends us cleaned-up JSON events instead.
//
// Setup (one-time, in RevenueCat dashboard):
//   1. Create a project, link to App Store Connect (paste the App Store
//      Server API key from App Store Connect → Users and Access → Keys).
//   2. Add Products: ${APPLE_PRODUCT_ID_PRO} and ${APPLE_PRODUCT_ID_ENTERPRISE}.
//      Optionally bundle them into Entitlements named "pro" / "enterprise".
//   3. Project Settings → API Keys → copy the public iOS SDK key into
//      REVENUECAT_PUBLIC_API_KEY_IOS.
//   4. Project Settings → Integrations → Webhooks:
//        URL: https://YOUR_API_HOST/api/payments/revenuecat/webhook
//        Authorization header value: <random string> → put in REVENUECAT_WEBHOOK_SECRET
//
// On iOS app start we call Purchases.logIn(supabaseUserId), so RevenueCat's
// `app_user_id` field always equals our Supabase user id. That's how we
// route incoming webhook events to the right subscription row.

router.get('/revenuecat/config', (_req, res) => {
  const apiKey = process.env.REVENUECAT_PUBLIC_API_KEY_IOS || null;
  if (!apiKey || !APPLE_PRODUCT.pro || !APPLE_PRODUCT.enterprise) {
    return res.status(503).json({
      error: 'RevenueCat configuration is incomplete',
      hasApiKey:              Boolean(apiKey),
      hasProductIdPro:        Boolean(APPLE_PRODUCT.pro),
      hasProductIdEnterprise: Boolean(APPLE_PRODUCT.enterprise),
    });
  }
  res.json({
    apiKey,
    productIdPro:        APPLE_PRODUCT.pro,
    productIdEnterprise: APPLE_PRODUCT.enterprise,
    bundleId:            APPLE_BUNDLE_ID,
  });
});

function rcProductToTier(productId) {
  if (!productId) return null;
  if (productId === APPLE_PRODUCT.enterprise) return 'enterprise';
  if (productId === APPLE_PRODUCT.pro)        return 'pro';
  return null;
}

// RevenueCat webhook — see https://www.revenuecat.com/docs/webhooks
router.post('/revenuecat/webhook', async (req, res) => {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  const got      = req.headers.authorization || '';
  if (!expected) {
    console.error('[revenuecat/webhook] REVENUECAT_WEBHOOK_SECRET not set — rejecting');
    return res.sendStatus(500);
  }
  if (got !== expected) {
    console.warn('[revenuecat/webhook] auth header mismatch');
    return res.sendStatus(401);
  }

  const event     = req.body?.event || {};
  const type      = event.type;
  const appUserId = event.app_user_id;
  const productId = event.product_id;
  const tier      = rcProductToTier(productId);
  const periodEnd = event.expiration_at_ms ? new Date(Number(event.expiration_at_ms)) : null;
  const txId      = event.transaction_id || event.original_transaction_id || event.id || null;
  // RevenueCat assigns each delivery a unique event.id (added in their
  // 2022 webhook revamp). Older payloads may not have it; fall back to
  // transaction_id which is stable per purchase. The composite unique
  // constraint will treat repeated transaction_ids on different event
  // types (RENEWAL then EXPIRATION on the same tx) as distinct.
  const eventId = event.id || (event.transaction_id ? `tx:${event.transaction_id}:${type}` : null);

  console.log(`[revenuecat/webhook] type=${type} user=${appUserId || '?'} product=${productId || '-'} tier=${tier || '-'}`);

  // app_user_id is set via Purchases.logIn(supabaseUserId) on the iOS side.
  // Anonymous IDs (RevenueCat's $RCAnonymousID:...) mean the user purchased
  // before logging in — we can't link these to a Supabase row. Drop quietly.
  if (!appUserId || /^\$RCAnonymousID:/.test(appUserId)) {
    return res.sendStatus(200);
  }

  // Idempotency log. RevenueCat's docs state events MAY be redelivered
  // when the server returns 5xx; without the dedupe gate, retries would
  // re-run upsertSubscription / cancelSubscription for the same logical
  // change. The DB-side upserts are themselves keyed on user_id+provider
  // so they're already idempotent in practice, but the audit log is the
  // source of truth for "did this event reach us" support questions.
  const log = await recordWebhookEvent({
    provider:  'revenuecat',
    eventId,
    eventType: type,
    userId:    appUserId,
    payload:   event,
  });
  if (!log.firstDelivery && log.rowId) {
    return res.sendStatus(200);
  }

  try {
    switch (type) {
      case 'TEST':
        // "Send test event" button in the dashboard. No-op.
        break;

      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'PRODUCT_CHANGE':
      case 'UNCANCELLATION':
        if (tier) {
          await upsertSubscription({
            userId:        appUserId,
            tier,
            provider:      'revenuecat',
            providerSubId: String(txId || appUserId),
            providerCusId: event.original_app_user_id || null,
            periodEnd,
            status:        'active',
          });
        }
        break;

      case 'CANCELLATION':
        // User cancelled but Apple keeps serving until expires_at_ms.
        // Don't flip status yet — just record the new period_end so the
        // app can show "expires on X". EXPIRATION fires later when it ends.
        if (periodEnd) {
          await sba.from('subscriptions')
            .update({ current_period_end: periodEnd.toISOString(), updated_at: new Date().toISOString() })
            .eq('user_id', appUserId);
        }
        break;

      case 'BILLING_ISSUE':
        await setSubscriptionStatus(appUserId, 'past_due');
        break;

      case 'EXPIRATION':
      case 'REFUND':
        await cancelSubscription(appUserId);
        break;

      default:
        // Ignored event types (logged above): SUBSCRIBER_ALIAS,
        // SUBSCRIPTION_PAUSED, INVOICE_ISSUANCE, NON_RENEWING_PURCHASE,
        // TEMPORARY_ENTITLEMENT_GRANT, TRANSFER, etc.
        break;
    }
    await markWebhookProcessed(log.rowId, appUserId);
  } catch (err) {
    console.error('[revenuecat/webhook]', err.message);
    await markWebhookFailed(log.rowId, err.message);
    // 5xx → RevenueCat retries with backoff. Use this for transient DB
    // failures so we don't lose state changes.
    return res.sendStatus(500);
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

// Helpers exported for the reconciliation cron
// (reconcileSubscriptionsCron.js). Server.js still mounts `router`
// the same way; everything else here is intentionally read-only
// from outside this module.
module.exports = {
  router,
  upsertSubscription,
  cancelSubscription,
  setSubscriptionStatus,
  appleProductToTier,
  rcProductToTier,
  getAppleVerifier,
  recordWebhookEvent,
  markWebhookProcessed,
  markWebhookFailed,
};
