#!/usr/bin/env node
'use strict';

/**
 * _diagnose_notifications.js
 *
 * Walks every gate that the briefing-notification dispatcher checks
 * and reports which one is failing. The dispatcher has ~7 silent
 * no-op paths; this script tells you exactly which one is biting.
 *
 * Run:   node _diagnose_notifications.js
 *        node _diagnose_notifications.js --user=<uuid>   (drill into one user)
 */

process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const USER_FILTER = ARGV.get('user') || null;

function ok(s) { return `\u001b[32m✓\u001b[0m ${s}`; }
function warn(s) { return `\u001b[33m⚠\u001b[0m ${s}`; }
function fail(s) { return `\u001b[31m✗\u001b[0m ${s}`; }
function pad(s, n) { return String(s || '').padEnd(n); }

(async () => {
  console.log('\n══════ Briefing notification diagnostic ══════\n');

  // ── 1. APNs env vars ─────────────────────────────────────────────────
  console.log('1. APNs environment');
  const apnsKeys = {
    APNS_KEY_ID:    process.env.APNS_KEY_ID,
    APNS_TEAM_ID:   process.env.APNS_TEAM_ID,
    APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
    APNS_KEY:       process.env.APNS_KEY ? `[${process.env.APNS_KEY.length} chars]` : null,
    APNS_KEY_PATH:  process.env.APNS_KEY_PATH,
    APNS_ENV:       process.env.APNS_ENV || '(default: sandbox)',
  };
  for (const [k, v] of Object.entries(apnsKeys)) {
    console.log('  ' + (v ? ok(`${pad(k, 18)} ${v}`) : fail(`${pad(k, 18)} MISSING`)));
  }
  const apnsConfigured = !!(apnsKeys.APNS_KEY_ID && apnsKeys.APNS_TEAM_ID
                            && apnsKeys.APNS_BUNDLE_ID
                            && (process.env.APNS_KEY || process.env.APNS_KEY_PATH));
  console.log('  ' + (apnsConfigured
    ? ok('apns.isConfigured() should return TRUE')
    : fail('apns.isConfigured() will return FALSE — cron exits before sending anything')));
  console.log('');

  // ── 2. Schema present? ───────────────────────────────────────────────
  console.log('2. Schema');
  for (const t of ['push_subscriptions', 'notification_preferences', 'notification_subscriptions', 'notification_log']) {
    const r = await pool.query(`SELECT to_regclass($1)::text AS t`, [`public.${t}`]);
    const exists = r.rows[0].t !== null;
    console.log('  ' + (exists ? ok(`table ${t}`) : fail(`table ${t} MISSING — run migrations/20260428_push_notifications.sql`)));
  }
  console.log('');

  // ── 3. Push subscriptions per user ───────────────────────────────────
  console.log('3. Push subscriptions');
  const ps = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE active = TRUE)::int AS active_count,
      COUNT(*) FILTER (WHERE platform = 'ios')::int AS ios_count,
      COUNT(*) FILTER (WHERE platform = 'ios' AND active = TRUE)::int AS ios_active,
      COUNT(DISTINCT user_id) FILTER (WHERE platform = 'ios' AND active = TRUE)::int AS ios_users
    FROM push_subscriptions
  `);
  const ps0 = ps.rows[0];
  console.log(`  total registrations:        ${ps0.total}`);
  console.log(`  active overall:             ${ps0.active_count}`);
  console.log(`  iOS active (cron filter):   ${ps0.ios_active}`);
  console.log(`  distinct iOS active users:  ${ps0.ios_users}`);
  if (!ps0.ios_active) {
    console.log('  ' + fail('zero iOS active push tokens — no one will receive briefing notifications'));
    console.log('  This means either no users have tapped "allow notifications" on iOS,');
    console.log('  OR the iOS app is not POSTing the token to /api/notifications/register-device.');
  } else {
    console.log('  ' + ok('iOS device tokens exist — fan-out will find recipients'));
  }
  console.log('');

  // ── 4. Notification preferences ──────────────────────────────────────
  console.log('4. Notification preferences');
  const np = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE enabled = TRUE)::int AS enabled_count,
      COUNT(*) FILTER (WHERE daily_briefing_on = TRUE)::int AS daily_on,
      COUNT(*) FILTER (WHERE daily_briefing_on = FALSE)::int AS daily_off
    FROM notification_preferences
  `);
  const np0 = np.rows[0];
  console.log(`  rows:                       ${np0.total}`);
  console.log(`  enabled=TRUE:               ${np0.enabled_count}`);
  console.log(`  daily_briefing_on=TRUE:     ${np0.daily_on}`);
  console.log(`  daily_briefing_on=FALSE:    ${np0.daily_off}`);
  console.log('  ' + warn('users with no row default to TRUE/TRUE/22-7 quiet/3 max — wide-open'));
  console.log('');

  // ── 5. Eligible recipient count for a hypothetical briefing now ─────
  console.log('5. Eligible recipients for a "ready" briefing right now');
  const elig = await pool.query(`
    SELECT COUNT(DISTINCT ps.user_id)::int AS c
      FROM push_subscriptions ps
      LEFT JOIN notification_preferences np ON np.user_id = ps.user_id
     WHERE ps.platform = 'ios'
       AND ps.active   = TRUE
       AND COALESCE(np.enabled, TRUE) = TRUE
       AND COALESCE(np.daily_briefing_on, TRUE) = TRUE
  `);
  console.log(`  recipients matching cron's WHERE clause: ${elig.rows[0].c}`);
  console.log('');

  // ── 6. Latest briefing episode + window check ────────────────────────
  console.log('6. Briefing episodes');
  const ep = await pool.query(`
    SELECT id, status, target_date, headline,
           generated_at,
           NOW() - generated_at AS age,
           user_id IS NULL AS is_global
      FROM briefing_episodes
      ORDER BY generated_at DESC
      LIMIT 5
  `);
  if (!ep.rows.length) {
    console.log('  ' + fail('no briefing_episodes rows at all — has briefingGenerator ever run?'));
  } else {
    console.log('  most recent 5:');
    ep.rows.forEach(r => {
      const ageHours = parseFloat(r.age?.hours ?? 0) +
                       (parseFloat(r.age?.minutes ?? 0) / 60) +
                       (parseFloat(r.age?.days ?? 0) * 24);
      // Match the dispatcher's DAILY_LOOKBACK_HOURS constant.
      const inWindow = ageHours <= 26;
      const tag = (r.status === 'ready' && r.is_global && inWindow) ? ok('eligible')
                 : (r.status !== 'ready') ? warn(`status=${r.status}`)
                 : (!r.is_global)         ? warn('user-specific (not a global broadcast)')
                 :                         warn(`> 26h old (cron lookback miss)`);
      console.log(`    ${r.id} ${pad(r.target_date, 12)} ${pad(r.status, 10)} ${pad('age=' + ageHours.toFixed(1) + 'h', 14)} ${tag}`);
    });
  }
  console.log('');

  // ── 7. Notification log — was anything ever sent? ────────────────────
  console.log('7. notification_log activity');
  const nl = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE delivered = TRUE)::int AS delivered_true,
      COUNT(*) FILTER (WHERE delivered = FALSE)::int AS delivered_false,
      COUNT(*) FILTER (WHERE delivered IS NULL)::int AS delivered_null,
      COUNT(*) FILTER (WHERE kind = 'briefing_daily')::int AS briefing_kind,
      MAX(sent_at) AS most_recent
    FROM notification_log
  `);
  const nl0 = nl.rows[0];
  console.log(`  total log rows:             ${nl0.total}`);
  console.log(`  delivered=TRUE:             ${nl0.delivered_true}`);
  console.log(`  delivered=FALSE (errored):  ${nl0.delivered_false}`);
  console.log(`  delivered=NULL (in flight): ${nl0.delivered_null}`);
  console.log(`  kind=briefing_daily:        ${nl0.briefing_kind}`);
  console.log(`  most recent attempt:        ${nl0.most_recent || '(never)'}`);
  if (nl0.delivered_false) {
    console.log('  Recent errors:');
    const errs = await pool.query(`
      SELECT user_id, kind, error_message, sent_at
        FROM notification_log
        WHERE delivered = FALSE
        ORDER BY sent_at DESC
        LIMIT 5
    `);
    errs.rows.forEach(r => {
      console.log(`    ${pad(r.kind, 18)} ${(r.user_id || '').slice(0, 8)} — ${r.error_message}`);
    });
  }
  console.log('');

  // ── 8. Per-user drill-down (when --user given) ──────────────────────
  if (USER_FILTER) {
    console.log(`8. User ${USER_FILTER}`);
    const u = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM push_subscriptions WHERE user_id=$1 AND active=TRUE AND platform='ios') AS active_ios_tokens,
        (SELECT row_to_json(np) FROM notification_preferences np WHERE user_id=$1) AS prefs,
        (SELECT COUNT(*)::int FROM notification_log WHERE user_id=$1) AS log_rows,
        (SELECT COUNT(*)::int FROM notification_log WHERE user_id=$1 AND log_date=CURRENT_DATE AND delivered=TRUE) AS today_delivered
    `, [USER_FILTER]);
    console.log('  ' + JSON.stringify(u.rows[0], null, 2).split('\n').join('\n  '));
  }

  // ── Verdict ──────────────────────────────────────────────────────────
  console.log('\n══════ Likely culprit ══════');
  if (!apnsConfigured) {
    console.log(fail('APNs env vars missing on the Render cron service.'));
    console.log('   The dispatcher exits at line 322-325 without attempting anything.');
    console.log('   ACTION: add APNS_KEY (the .p8 contents), APNS_KEY_ID, APNS_TEAM_ID,');
    console.log('   APNS_BUNDLE_ID to the cron-notifications service env on Render.');
  } else if (!ps0.ios_active) {
    console.log(fail('No active iOS push tokens registered.'));
    console.log('   Either users have not granted notifications, or the iOS app is not');
    console.log('   POSTing tokens to /api/notifications/register-device.');
  } else if (!ep.rows.some(r => r.status === 'ready' && r.is_global)) {
    console.log(fail('No briefing_episodes with status=ready AND user_id IS NULL.'));
    console.log('   The dispatcher only sends global briefings (where user_id is null).');
    console.log('   Per-user briefings would need a separate path.');
  } else if (nl0.briefing_kind === 0) {
    console.log(warn('Dispatcher has never logged a briefing_daily row.'));
    console.log('   Check that the cron is actually scheduled on Render.');
    console.log('   Run manually: node notificationDispatcher.js — see what it logs.');
  } else if (nl0.delivered_false > 0) {
    console.log(warn('Dispatcher ran but APNs is rejecting the sends.'));
    console.log('   See the recent errors above for the specific failure mode.');
  } else {
    console.log(ok('Everything looks plumbed. Run "node notificationDispatcher.js"'));
    console.log('   manually and watch the output for the specific gate that fails.');
  }
  console.log('');

  await pool.end().catch(() => {});
})().catch(e => { console.error('diagnose failed:', e); process.exit(1); });
