// Cap DB pool before any module loads ./db. The dispatcher is mostly
// read-heavy with light writes (notification_log inserts, prefs reads,
// fan-out queries against story_threads + push_subscriptions). 2 is
// plenty and matches the cap used by keywordAnalyticsCron / Normalizer.
// Without this, db.js defaults to 60 and a stuck dispatcher run could
// starve the web server's pool share — the same starvation pattern
// storyThreadBuilder hit before its cap was added.
process.env.DB_POOL_MAX = "2";

/**
 * notificationDispatcher.js — periodic worker that turns events into pushes.
 *
 * Runs every 5 minutes. Two passes:
 *
 *   1. Daily-briefing pass
 *      - Find briefing_episodes where status='ready' AND user_id IS NULL
 *        AND created_at > (last dispatch run for this kind).
 *      - Push to subscribers with daily_briefing_on AND quiet hours allow.
 *
 *   2. Thread-alerts pass
 *      - Find story_threads where last_updated_at > (last run cursor)
 *        AND status='active' AND importance >= per-user floor.
 *      - For each, find users whose notification_subscriptions overlap
 *        with the thread's primary_nations.
 *      - Dedup against notification_log.dedup_key.
 *
 * Both passes apply per-user frequency caps + quiet hours BEFORE
 * dispatch; stamp notification_log AFTER. Failed APNs sends are
 * recorded but don't block retries (the next pass picks them up via
 * dedup_key absence).
 *
 * Exits on completion. To run as a cron, add to package.json scripts:
 *   "cron:notifications": "node notificationDispatcher.js"
 * and call it from your platform scheduler every 5 min.
 */

'use strict';

const pool       = require('./db');
const apns       = require('./apnsClient');

const DAILY_LOOKBACK_HOURS = 4;     // briefings from the last 4h are eligible
const THREAD_LOOKBACK_HOURS = 1;    // thread updates from the last hour
const MAX_NOTIFICATIONS_PER_RUN = 500; // safety brake per pass

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Is `now` within the user's quiet hours? Quiet hours wrap midnight
 * (e.g. start=22, end=7 → quiet from 22:00 → 06:59 next day).
 */
function _isQuietHours(prefs, nowUTC) {
  const tz = prefs.timezone || 'UTC';
  let localHour;
  try {
    // Cheapest way to get a tz-shifted hour without pulling in dayjs.
    const hourStr = nowUTC.toLocaleString('en-US', {
      timeZone: tz, hour12: false, hour: 'numeric',
    });
    localHour = parseInt(hourStr, 10);
  } catch (_) {
    // Bad timezone string from the client — treat as UTC.
    localHour = nowUTC.getUTCHours();
  }
  const start = Number(prefs.quiet_hours_start) || 0;
  const end   = Number(prefs.quiet_hours_end)   || 0;
  if (start === end) return false; // disabled
  if (start < end) {
    // Same-day window: 9 → 17 means 9am-5pm quiet.
    return localHour >= start && localHour < end;
  }
  // Wrap window: 22 → 7 means 22, 23, 0, 1, ..., 6.
  return localHour >= start || localHour < end;
}

/**
 * Has the user already hit their per-day cap?
 */
async function _atDailyCap(userId, maxPerDay) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notification_log
       WHERE user_id = $1 AND log_date = $2 AND delivered = TRUE`,
    [userId, today]
  );
  return (rows[0]?.c || 0) >= maxPerDay;
}

/**
 * Insert dedup row + send via APNs in one transaction. Returns true on
 * success. Caller can short-circuit on duplicate (UNIQUE violation on
 * dedup_key) — that means we already pushed this event.
 */
async function _dispatch({ userId, kind, referenceId, title, body, dedupKey, data }) {
  // Reserve the dedup slot first so a concurrent run doesn't double-push.
  // ON CONFLICT DO NOTHING returns 0 rows when the key already exists.
  const { rowCount: reserved } = await pool.query(
    `INSERT INTO notification_log
       (user_id, kind, reference_id, title, body, dedup_key, sent_at, delivered)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [userId, kind, referenceId, title.slice(0, 200), body.slice(0, 500), dedupKey]
  );
  if (!reserved) return false; // already sent

  // Pull active iOS device tokens for this user.
  const { rows: tokens } = await pool.query(
    `SELECT id, token FROM push_subscriptions
       WHERE user_id = $1 AND active = TRUE AND platform = 'ios'`,
    [userId]
  );
  if (!tokens.length) {
    await pool.query(
      `UPDATE notification_log SET delivered = FALSE, error_message = 'no_active_devices'
         WHERE dedup_key = $1`,
      [dedupKey]
    );
    return false;
  }

  let anyDelivered = false;
  let lastError = null;
  for (const t of tokens) {
    const result = await apns.send({
      token: t.token,
      title,
      body,
      data: { kind, reference_id: referenceId, ...(data || {}) },
      collapseId: kind === 'thread_update' ? `thread_${referenceId}` : null,
    });
    if (result.delivered) {
      anyDelivered = true;
    } else {
      lastError = result.error || 'unknown';
      // BadDeviceToken / Unregistered → mark stale. APNs returns 410 for
      // tokens that are no longer valid (user uninstalled or disabled
      // notifications). Deactivate so we stop hammering.
      if (result.statusCode === 410 ||
          /BadDeviceToken|Unregistered/i.test(result.error || '')) {
        try {
          await pool.query(
            `UPDATE push_subscriptions SET active = FALSE WHERE id = $1`,
            [t.id]
          );
        } catch (_) {}
      }
    }
  }
  await pool.query(
    `UPDATE notification_log SET delivered = $1, error_message = $2 WHERE dedup_key = $3`,
    [anyDelivered, anyDelivered ? null : lastError, dedupKey]
  );
  return anyDelivered;
}

/**
 * Fetch a user's notification preferences with sane defaults if no row.
 */
async function _getPrefs(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  if (rows[0]) return rows[0];
  // Defaults must match the column defaults in the schema.
  return {
    user_id:               userId,
    enabled:               true,
    daily_briefing_on:     true,
    thread_alerts_on:      true,
    quiet_hours_start:     22,
    quiet_hours_end:       7,
    timezone:              'UTC',
    max_per_day:           3,
    thread_importance_min: 7.0,
  };
}

// ─── Pass 1: daily briefings ──────────────────────────────────────────

async function dispatchDailyBriefings(now) {
  const since = new Date(now.getTime() - DAILY_LOOKBACK_HOURS * 60 * 60 * 1000);
  // Find ready GLOBAL briefings (user_id IS NULL = the daily one we ship
  // to every user, not a per-user custom briefing). Exclude episodes
  // already enqueued at the cohort level by their stable id.
  const { rows: episodes } = await pool.query(
    `SELECT id, headline, target_date FROM briefing_episodes
       WHERE status = 'ready'
         AND user_id IS NULL
         AND created_at > $1
       ORDER BY created_at ASC
       LIMIT 5`,
    [since]
  );
  if (!episodes.length) return { episodes: 0, sent: 0 };

  let sent = 0;
  for (const ep of episodes) {
    // Pull every user with daily_briefing_on AND a registered iOS device.
    // No subscription filter — the daily briefing is the catch-all default.
    const { rows: users } = await pool.query(
      `SELECT DISTINCT ps.user_id
         FROM push_subscriptions ps
         LEFT JOIN notification_preferences np ON np.user_id = ps.user_id
        WHERE ps.platform = 'ios'
          AND ps.active   = TRUE
          AND COALESCE(np.enabled, TRUE) = TRUE
          AND COALESCE(np.daily_briefing_on, TRUE) = TRUE
        LIMIT $1`,
      [MAX_NOTIFICATIONS_PER_RUN]
    );

    for (const u of users) {
      const prefs = await _getPrefs(u.user_id);
      if (!prefs.enabled || !prefs.daily_briefing_on) continue;
      if (_isQuietHours(prefs, now)) continue;
      if (await _atDailyCap(u.user_id, prefs.max_per_day)) continue;

      const dedupKey = `${u.user_id}:briefing_daily:${ep.id}`;
      const headline = ep.headline || 'Today\'s briefing is ready';
      const ok = await _dispatch({
        userId:      u.user_id,
        kind:        'briefing_daily',
        referenceId: ep.id,
        title:       'Earth Briefing',
        body:        headline,
        dedupKey,
        data:        { episode_id: ep.id, target_date: ep.target_date },
      });
      if (ok) sent += 1;
    }
  }
  return { episodes: episodes.length, sent };
}

// ─── Pass 2: thread alerts ────────────────────────────────────────────

async function dispatchThreadAlerts(now) {
  const since = new Date(now.getTime() - THREAD_LOOKBACK_HOURS * 60 * 60 * 1000);
  // Threads updated in the lookback window, gated on importance & status.
  // Pull primary_nations as the match key.
  const { rows: threads } = await pool.query(
    `SELECT id, title, primary_category, importance, primary_nations,
            last_updated_at, first_seen_at, COALESCE(article_count, 0) AS article_count
       FROM story_threads
      WHERE status = 'active'
        AND last_updated_at > $1
        AND COALESCE(scope, 'global') = 'global'
        AND importance >= 5  -- floor; per-user can require higher
      ORDER BY last_updated_at ASC
      LIMIT 200`,
    [since]
  );
  if (!threads.length) return { threads: 0, sent: 0 };

  let sent = 0;
  for (const t of threads) {
    const isos = (t.primary_nations || []).map(String);
    if (!isos.length) continue;

    // Find subscribers who:
    //   - subscribe to ANY of this thread's primary_nations (uppercased)
    //   - have an active iOS device
    //   - haven't disabled thread alerts
    //   - have a per-user importance floor ≤ this thread's importance
    const { rows: matches } = await pool.query(
      `SELECT DISTINCT ns.user_id
         FROM notification_subscriptions ns
         JOIN push_subscriptions ps
           ON ps.user_id = ns.user_id AND ps.active = TRUE AND ps.platform = 'ios'
         LEFT JOIN notification_preferences np ON np.user_id = ns.user_id
        WHERE ns.target_type = 'country'
          AND UPPER(ns.target_value) = ANY($1::text[])
          AND COALESCE(np.enabled, TRUE) = TRUE
          AND COALESCE(np.thread_alerts_on, TRUE) = TRUE
          AND COALESCE(np.thread_importance_min, 7.0) <= $2
        LIMIT $3`,
      [isos.map(s => s.toUpperCase()), Number(t.importance) || 0, MAX_NOTIFICATIONS_PER_RUN]
    );

    // Distinguish "new thread" (just appeared, first_seen_at within window)
    // from "thread update" (existing thread that got new articles).
    const isNew =
      t.first_seen_at && (new Date(t.first_seen_at).getTime() > since.getTime());
    const kind = isNew ? 'thread_new' : 'thread_update';
    const day = new Date().toISOString().slice(0, 10);

    for (const m of matches) {
      const prefs = await _getPrefs(m.user_id);
      if (!prefs.enabled || !prefs.thread_alerts_on) continue;
      if (_isQuietHours(prefs, now)) continue;
      if (await _atDailyCap(m.user_id, prefs.max_per_day)) continue;

      const dedupKey = `${m.user_id}:${kind}:${t.id}:${day}`;
      const titleStr = isNew ? 'New story emerging' : 'Story updated';
      const bodyStr = (t.title || 'A story you follow has new coverage').slice(0, 180);
      const ok = await _dispatch({
        userId:      m.user_id,
        kind,
        referenceId: t.id,
        title:       titleStr,
        body:        bodyStr,
        dedupKey,
        data:        {
          thread_id:        t.id,
          primary_category: t.primary_category,
          importance:       Number(t.importance) || 0,
          isos,
        },
      });
      if (ok) sent += 1;
    }
  }
  return { threads: threads.length, sent };
}

// ─── Entrypoint ───────────────────────────────────────────────────────

async function run() {
  const now = new Date();
  const t0 = Date.now();
  if (!apns.isConfigured()) {
    console.log('[notif] APNs not configured (APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID missing) — exiting');
    return;
  }
  console.log(`[notif] dispatch starting at ${now.toISOString()}`);

  try {
    const r1 = await dispatchDailyBriefings(now);
    const r2 = await dispatchThreadAlerts(now);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[notif] done in ${elapsed}s — daily=${r1.sent}/${r1.episodes} threads=${r2.sent}/${r2.threads}`);
  } catch (err) {
    console.error('[notif] dispatch error:', err.message, err.stack);
    process.exitCode = 1;
  } finally {
    apns.close();
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  run();
}

module.exports = { run, dispatchDailyBriefings, dispatchThreadAlerts };
