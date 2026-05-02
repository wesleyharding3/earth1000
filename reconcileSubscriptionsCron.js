#!/usr/bin/env node
'use strict';

/**
 * reconcileSubscriptionsCron.js
 *
 * Hourly job that fetches the *live* subscription state from each
 * payment provider (Apple StoreKit Server API, RevenueCat REST API,
 * PayPal Subscriptions API) and reconciles it against our local
 * `subscriptions` table. Catches every gap left by webhook delivery:
 *
 *   • Webhook lost during a deploy / network blip → provider state
 *     diverges from local DB. Reconciler closes the gap.
 *   • Apple/RC/PayPal gave up retrying after their max-attempt window
 *     (24h Apple, 3 days PayPal, ~24h RevenueCat). Reconciler still
 *     finds the new state and applies it.
 *   • Webhook processed but DB write half-failed mid-transaction.
 *     Reconciler reads the live state and overwrites local.
 *
 * Run cadence: hourly is the conservative target. Each run caps work
 * at RUN_LIMIT subs (default 500) ordered by `updated_at` ascending,
 * so the oldest-checked rows get refreshed first and the table cycles
 * through over time. Active-but-past_due subs and subs whose
 * `current_period_end` is within the next 24h get bumped to the front
 * of the queue (those are where drift hurts most).
 *
 * Required env vars (per provider — provider is skipped gracefully
 * when its env is unset):
 *
 *   Apple:
 *     APPLE_BUNDLE_ID                        (already in payments.js)
 *     APPLE_ENV                              ('production' or 'sandbox')
 *     APPLE_STOREKIT_KEY_ID                  (from App Store Connect → Keys → In-App Purchase)
 *     APPLE_STOREKIT_ISSUER_ID               (from App Store Connect → Users and Access → Keys)
 *     APPLE_STOREKIT_PRIVATE_KEY             (the contents of the .p8 file, NOT a path)
 *                                            OR APPLE_STOREKIT_PRIVATE_KEY_PATH (filesystem path)
 *
 *   RevenueCat:
 *     REVENUECAT_SECRET_API_KEY              (different from the iOS SDK key —
 *                                             this is the server-side key from
 *                                             RC dashboard → API Keys → Secret keys)
 *
 *   PayPal:
 *     PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (already in payments.js)
 *     PAYPAL_ENV
 *
 * Run:   node reconcileSubscriptionsCron.js
 * Args:  --limit=N          override per-run cap (default 500)
 *        --provider=apple   only reconcile one provider
 *        --dry              compute drift but don't apply DB writes
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
process.env.DB_APPLICATION_NAME =
  process.env.DB_APPLICATION_NAME || 'earth-cron-reconcile';

const fs   = require('fs');
const path = require('path');
const pool = require('./db');
const sba  = require('./supabaseAdmin');
const {
  upsertSubscription,
  cancelSubscription,
  setSubscriptionStatus,
  appleProductToTier,
  rcProductToTier,
} = require('./payments');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const RUN_LIMIT       = parseInt(ARGV.get('limit') || '500', 10);
const PROVIDER_FILTER = ARGV.get('provider') || null;
const DRY             = !!ARGV.get('dry');

const CONCURRENCY      = 5;
const PER_CALL_TIMEOUT = 15000;

// Drift thresholds for end-of-run alerting. We always log the per-provider
// summary; these thresholds promote it to a structured WARN/ALERT line that
// log aggregation (or a `grep` from a monitoring cron) can pick up. Tunable
// from the env so we don't have to redeploy to quiet a noisy run.
//   * WARN  — likely investigate. Either a bursty webhook outage or a
//             provider behaving oddly. Not actionable by itself.
//   * ALERT — almost certainly something broken (e.g. webhook handler
//             returning 500 for a class of events, or a misconfigured env
//             var causing every check to drift). Page someone.
const DRIFT_WARN_THRESHOLD  = parseInt(process.env.RECONCILE_WARN_THRESHOLD  || '10', 10);
const DRIFT_ALERT_THRESHOLD = parseInt(process.env.RECONCILE_ALERT_THRESHOLD || '50', 10);
const DRIFT_ALERT_RATIO     = Number(process.env.RECONCILE_ALERT_RATIO || '0.25'); // 25% of checked

const TAG = '[reconcile]';

// ─── Apple StoreKit Server API ───────────────────────────────────────────
const { AppStoreServerAPIClient, Environment } =
  require('@apple/app-store-server-library');

let _appleClient = null;
function getAppleClient() {
  if (_appleClient) return _appleClient;
  const keyId    = process.env.APPLE_STOREKIT_KEY_ID;
  const issuerId = process.env.APPLE_STOREKIT_ISSUER_ID;
  const bundleId = process.env.APPLE_BUNDLE_ID || 'com.earth00.app';
  const env = (process.env.APPLE_ENV || 'sandbox').toLowerCase() === 'production'
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
  if (!keyId || !issuerId) {
    return null; // env not set; caller skips Apple
  }
  let privateKey = process.env.APPLE_STOREKIT_PRIVATE_KEY;
  if (!privateKey && process.env.APPLE_STOREKIT_PRIVATE_KEY_PATH) {
    try {
      privateKey = fs.readFileSync(
        path.resolve(process.env.APPLE_STOREKIT_PRIVATE_KEY_PATH),
        'utf8'
      );
    } catch (e) {
      console.warn(`${TAG} Apple private key path unreadable: ${e.message}`);
      return null;
    }
  }
  if (!privateKey) return null;
  _appleClient = new AppStoreServerAPIClient(
    privateKey,
    keyId,
    issuerId,
    bundleId,
    env
  );
  return _appleClient;
}

// Map Apple's numeric subscription status → our local string status.
// Reference: developer.apple.com/documentation/appstoreserverapi/status
function appleStatusToLocal(n) {
  switch (Number(n)) {
    case 1: return 'active';        // Active (current period valid)
    case 2: return 'canceled';      // Expired
    case 3: return 'past_due';      // Billing retry
    case 4: return 'active';        // Grace period — treat as active for entitlements
    case 5: return 'canceled';      // Revoked
    default: return null;
  }
}

async function reconcileAppleOne(sub) {
  const client = getAppleClient();
  if (!client) return { skipped: true, reason: 'no apple client' };
  const originalTransactionId = sub.provider_sub_id;
  if (!originalTransactionId) return { skipped: true, reason: 'no provider_sub_id' };

  const result = await Promise.race([
    client.getAllSubscriptionStatuses(originalTransactionId),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), PER_CALL_TIMEOUT)),
  ]);

  // Response shape: { data: [{ subscriptionGroupIdentifier, lastTransactions: [...] }] }
  // Latest transaction in the group carries current status.
  const tx = result?.data?.[0]?.lastTransactions?.[0];
  if (!tx) return { skipped: true, reason: 'no transactions returned' };

  const liveStatus = appleStatusToLocal(tx.status);
  if (!liveStatus) return { skipped: true, reason: `unknown apple status ${tx.status}` };

  // Decode the signedTransactionInfo for the period_end + product_id.
  // We don't need to verify here (we're talking to Apple directly) but
  // the JWS payload is base64-decoded JSON so a quick decode gives us
  // the data without dragging in the whole verifier.
  let periodEnd = null;
  let liveTier  = null;
  try {
    if (tx.signedTransactionInfo) {
      const parts = tx.signedTransactionInfo.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload.expiresDate) periodEnd = new Date(Number(payload.expiresDate));
        if (payload.productId)   liveTier  = appleProductToTier(payload.productId);
      }
    }
  } catch (_) {
    // Decode failed — keep going with what we have.
  }

  return applyDrift(sub, { liveStatus, liveTier, periodEnd, provider: 'apple' });
}

// ─── RevenueCat REST API ──────────────────────────────────────────────────
async function reconcileRevenueCatOne(sub) {
  const apiKey = process.env.REVENUECAT_SECRET_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'no RC secret key' };

  const url = `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(sub.user_id)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Platform':  'iOS',
        'Accept':      'application/json',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (res.status === 404) return { skipped: true, reason: 'RC 404 (no subscriber)' };
  if (!res.ok) throw new Error(`RC HTTP ${res.status}`);

  const data = await res.json();
  // RC subscriber shape: { subscriber: { entitlements: { ent_name: { expires_date, product_identifier, ... } }, subscriptions: { product_id: { expires_date, ... } } } }
  const subscriber = data?.subscriber || {};
  const entitlements = subscriber.entitlements || {};
  // Find any active entitlement.
  const now = Date.now();
  let liveStatus = 'canceled';
  let liveTier   = null;
  let periodEnd  = null;
  for (const [, ent] of Object.entries(entitlements)) {
    const exp = ent?.expires_date ? new Date(ent.expires_date).getTime() : null;
    if (exp == null) continue;
    if (exp > now) {
      liveStatus = 'active';
      liveTier   = rcProductToTier(ent.product_identifier);
      periodEnd  = new Date(exp);
      break;
    }
  }
  return applyDrift(sub, { liveStatus, liveTier, periodEnd, provider: 'revenuecat' });
}

// ─── PayPal Subscriptions API ─────────────────────────────────────────────
let _ppToken = null;
let _ppTokenExpiry = 0;
async function getPayPalAccessToken() {
  if (_ppToken && Date.now() < _ppTokenExpiry - 30000) return _ppToken;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials missing');
  const env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  const base = env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const creds = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method:  'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error ${r.status}`);
  const d = await r.json();
  _ppToken = d.access_token;
  _ppTokenExpiry = Date.now() + d.expires_in * 1000;
  return _ppToken;
}

// PayPal returns plan_id on the subscription resource. Map it back to our
// internal tier name using the same env vars that drive new signups. Unknown
// plans (legacy/manual/promotional) map to null so applyDrift's
// `liveTier && localTier && ...` guard skips tier reconciliation rather than
// risk a wrong downgrade. Same fail-safe shape as before — only difference
// is we'll *catch* drift for plans we know about.
function paypalPlanIdToTier(planId) {
  if (!planId) return null;
  if (planId === process.env.PAYPAL_PLAN_ID_PRO)        return 'pro';
  if (planId === process.env.PAYPAL_PLAN_ID_ENTERPRISE) return 'enterprise';
  return null;
}

async function reconcilePayPalOne(sub) {
  if (!process.env.PAYPAL_CLIENT_ID) return { skipped: true, reason: 'no PayPal credentials' };
  const subscriptionId = sub.provider_sub_id;
  if (!subscriptionId) return { skipped: true, reason: 'no provider_sub_id' };
  const token = await getPayPalAccessToken();
  const env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  const base = env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const url = `${base}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal:  ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (res.status === 404) return { skipped: true, reason: 'PayPal 404' };
  if (!res.ok) throw new Error(`PayPal HTTP ${res.status}`);

  const data = await res.json();
  // PayPal subscription.status: APPROVAL_PENDING | APPROVED | ACTIVE
  // | SUSPENDED | CANCELLED | EXPIRED
  let liveStatus = 'canceled';
  if (data.status === 'ACTIVE' || data.status === 'APPROVED') liveStatus = 'active';
  else if (data.status === 'SUSPENDED') liveStatus = 'past_due';
  // CANCELLED, EXPIRED → canceled

  const periodEnd = data.billing_info?.next_billing_time
    ? new Date(data.billing_info.next_billing_time)
    : null;

  const liveTier = paypalPlanIdToTier(data.plan_id);

  return applyDrift(sub, { liveStatus, liveTier, periodEnd, provider: 'paypal' });
}

// ─── Drift application ────────────────────────────────────────────────────
// Compares live state to local state, returns a result object describing
// what changed. When DRY is true, no DB writes happen — only the diff
// is computed for logging.
async function applyDrift(sub, { liveStatus, liveTier, periodEnd, provider }) {
  const localStatus = sub.status;
  const localPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const localTier = sub.tier_name || null;

  const drift = {
    user_id:            sub.user_id,
    provider,
    local_status:       localStatus,
    live_status:        liveStatus,
    local_period_end:   localPeriodEnd?.toISOString() || null,
    live_period_end:    periodEnd?.toISOString() || null,
    local_tier:         localTier,
    live_tier:          liveTier,
    action:             null,
  };

  // Determine action.
  const statusDrift  = liveStatus && liveStatus !== localStatus;
  const periodDrift  = periodEnd && (!localPeriodEnd ||
                       Math.abs(periodEnd.getTime() - localPeriodEnd.getTime()) > 60_000);
  const tierDrift    = liveTier && localTier && liveTier !== localTier;

  if (!statusDrift && !periodDrift && !tierDrift) {
    drift.action = 'no_drift';
    return drift;
  }

  // Pick action based on the live status. Tier+period changes go through
  // upsertSubscription so all three fields can update atomically.
  if (DRY) {
    drift.action = statusDrift ? `would_set_${liveStatus}` :
                   tierDrift  ? `would_change_tier_${localTier}_to_${liveTier}` :
                                'would_update_period_end';
    return drift;
  }

  try {
    if (liveStatus === 'canceled') {
      await cancelSubscription(sub.user_id);
      drift.action = 'canceled_local';
    } else if (liveStatus === 'past_due') {
      await setSubscriptionStatus(sub.user_id, 'past_due');
      drift.action = 'past_due_local';
    } else if (liveStatus === 'active') {
      // Active live → reactivate or refresh period_end + tier
      const tierToWrite = liveTier || localTier;
      if (!tierToWrite) {
        // No tier we can resolve; just flip status.
        await setSubscriptionStatus(sub.user_id, 'active');
        drift.action = 'reactivated_status_only';
      } else {
        await upsertSubscription({
          userId:        sub.user_id,
          tier:          tierToWrite,
          provider,
          providerSubId: sub.provider_sub_id,
          providerCusId: sub.provider_cus_id,
          periodEnd,
          status:        'active',
        });
        drift.action = 'upserted_active';
      }
    }
  } catch (e) {
    drift.action = `error: ${e.message}`;
  }
  return drift;
}

// ─── Concurrency helper ───────────────────────────────────────────────────
async function processWithConcurrency(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        const r = await fn(items[i]);
        results[i] = r;
      } catch (e) {
        results[i] = { error: e.message, item: items[i] };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} mode=${DRY ? 'DRY' : 'LIVE'} limit=${RUN_LIMIT}${PROVIDER_FILTER ? ` provider=${PROVIDER_FILTER}` : ''}`);

  // Pull subscriptions to check. Priority: past_due first (most likely
  // to have drift), then active subs whose period_end is within the
  // next 24h (renewal incoming, fresh state needed), then everything
  // else by oldest-updated-first (rotating audit). We cap at RUN_LIMIT
  // total so a single run is bounded regardless of pool size.
  const { data: subs, error } = await sba
    .from('subscriptions')
    .select('user_id, provider, provider_sub_id, provider_cus_id, status, current_period_end, updated_at, tier:subscription_tiers(name)')
    .in('status', ['active', 'past_due'])
    .order('status', { ascending: false })          // past_due before active (alpha order works)
    .order('current_period_end', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: true })
    .limit(RUN_LIMIT);

  if (error) {
    console.error(`${TAG} fetch failed:`, error.message);
    process.exit(1);
  }

  // Flatten the supabase nested join
  const subList = (subs || []).map(s => ({
    user_id:           s.user_id,
    provider:          s.provider,
    provider_sub_id:   s.provider_sub_id,
    provider_cus_id:   s.provider_cus_id,
    status:            s.status,
    current_period_end:s.current_period_end,
    updated_at:        s.updated_at,
    tier_name:         s.tier?.name || null,
  }));

  console.log(`${TAG} fetched ${subList.length} subscriptions`);

  // Bucket by provider; apply optional --provider filter.
  const byProvider = { apple: [], revenuecat: [], paypal: [] };
  for (const s of subList) {
    if (PROVIDER_FILTER && s.provider !== PROVIDER_FILTER) continue;
    if (byProvider[s.provider]) byProvider[s.provider].push(s);
  }
  console.log(`${TAG} bucketed: apple=${byProvider.apple.length} revenuecat=${byProvider.revenuecat.length} paypal=${byProvider.paypal.length}`);

  const allDrifts = [];
  const summary = { apple: { checked: 0, drifted: 0, errors: 0, skipped: 0 },
                    revenuecat: { checked: 0, drifted: 0, errors: 0, skipped: 0 },
                    paypal: { checked: 0, drifted: 0, errors: 0, skipped: 0 } };

  for (const [provider, list] of Object.entries(byProvider)) {
    if (!list.length) continue;
    const fn = provider === 'apple'      ? reconcileAppleOne :
               provider === 'revenuecat' ? reconcileRevenueCatOne :
                                            reconcilePayPalOne;
    const drifts = await processWithConcurrency(list, fn, CONCURRENCY);
    for (let i = 0; i < drifts.length; i++) {
      const d = drifts[i] || {};
      summary[provider].checked++;
      if (d.error)      summary[provider].errors++;
      if (d.skipped)    summary[provider].skipped++;
      if (d.action && d.action !== 'no_drift' && !d.skipped) summary[provider].drifted++;
      if (d.error || (d.action && d.action !== 'no_drift') || d.skipped) {
        allDrifts.push({ provider, ...d, item: undefined });
        const id = (list[i].user_id || '').slice(0, 8);
        const tag = d.error ? `ERROR ${d.error}` :
                    d.skipped ? `SKIP ${d.reason || ''}` :
                    `${d.action} (${d.local_status}→${d.live_status})`;
        console.log(`${TAG}   [${provider}] ${id} ${tag}`);
      }
    }
  }

  console.log(`${TAG} summary:`);
  for (const [p, s] of Object.entries(summary)) {
    console.log(`${TAG}   ${p.padEnd(11)} checked=${s.checked} drifted=${s.drifted} errors=${s.errors} skipped=${s.skipped}`);
  }
  console.log(`${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s${DRY ? ' (DRY — no writes)' : ''}`);

  // ── Threshold alerting ────────────────────────────────────────────────
  // Aggregate counts across providers so a single bad provider is enough
  // to trip the alert. The structured prefix (RECONCILE_ALERT / _WARN) is
  // what monitoring greps for — keep it stable.
  const totals = Object.values(summary).reduce(
    (acc, s) => ({
      checked: acc.checked + s.checked,
      drifted: acc.drifted + s.drifted,
      errors:  acc.errors  + s.errors,
    }),
    { checked: 0, drifted: 0, errors: 0 }
  );
  const driftRatio = totals.checked > 0 ? totals.drifted / totals.checked : 0;
  const isAlert = totals.drifted >= DRIFT_ALERT_THRESHOLD ||
                  (totals.checked >= 20 && driftRatio >= DRIFT_ALERT_RATIO);
  const isWarn  = !isAlert && totals.drifted >= DRIFT_WARN_THRESHOLD;
  if (isAlert || isWarn) {
    const level = isAlert ? 'RECONCILE_ALERT' : 'RECONCILE_WARN';
    // One structured line that's easy to grep + parse. Keys are stable.
    console.warn(`[${level}] checked=${totals.checked} drifted=${totals.drifted} ratio=${driftRatio.toFixed(3)} errors=${totals.errors} apple_drift=${summary.apple.drifted} rc_drift=${summary.revenuecat.drifted} paypal_drift=${summary.paypal.drifted} dry=${DRY}`);
  }

  // Write a compact log file for offline review.
  if (allDrifts.length) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const f = path.join(dir, `reconcile-${ts}.json`);
    try {
      fs.writeFileSync(f, JSON.stringify({ summary, drifts: allDrifts }, null, 2));
      console.log(`${TAG} drift log → ${f}`);
    } catch (_) {}
  }

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
