-- ─────────────────────────────────────────────────────────────────────
-- Push notifications — Phase 1 foundation.
--
-- Four tables:
--   push_subscriptions       — device tokens registered for APNs.
--   notification_preferences — per-user defaults (briefing on, frequency,
--                              quiet hours, timezone).
--   notification_subscriptions — many-to-many user → country (extensible
--                              to entity/keyword later via target_type).
--   notification_log         — outbound dispatch record + dedup key.
--
-- iOS-first launch. Web Push fields (p256dh, auth) included anyway since
-- the Web Push schema is uncontroversial and adding columns later means
-- a migration on a hot table.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  -- 'ios' (APNs token) | 'web' (Web Push endpoint, future)
  platform        TEXT NOT NULL CHECK (platform IN ('ios', 'web')),
  -- APNs device token (hex string) OR full Web Push endpoint URL.
  token           TEXT NOT NULL,
  -- Web Push only — encryption keys (NULL for iOS).
  p256dh          TEXT,
  auth            TEXT,
  -- APNs bundle id / Web Push origin for routing.
  app_id          TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Same physical device shouldn't have two active rows for one user.
  UNIQUE (user_id, platform, token)
);

-- Lookup by user when dispatching, common case.
CREATE INDEX IF NOT EXISTS idx_push_subs_user_active
  ON push_subscriptions (user_id) WHERE active;

-- For cleanup jobs (deactivate stale tokens).
CREATE INDEX IF NOT EXISTS idx_push_subs_last_seen
  ON push_subscriptions (last_seen_at) WHERE active;


CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              UUID PRIMARY KEY,
  -- Master switch. Off = no pushes regardless of subscriptions.
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  -- Daily briefing notification (the auto-on default we promised users).
  daily_briefing_on    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Per-country thread alerts. Off until user adds a subscription.
  thread_alerts_on     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Local-time quiet window. Default 22:00 → 07:00.
  quiet_hours_start    SMALLINT NOT NULL DEFAULT 22 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end      SMALLINT NOT NULL DEFAULT  7 CHECK (quiet_hours_end   BETWEEN 0 AND 23),
  -- IANA timezone for quiet-hour math. Default to UTC; client posts the
  -- browser/device timezone at registration time.
  timezone             TEXT NOT NULL DEFAULT 'UTC',
  -- Hard cap on dispatch volume per user per day. 3 = sane default.
  max_per_day          SMALLINT NOT NULL DEFAULT 3 CHECK (max_per_day BETWEEN 1 AND 20),
  -- Importance floor for thread alerts. story_threads.importance is on
  -- a 0-10 scale; default 7 = "established stories the user actually cares
  -- about" without spamming on every minor update.
  thread_importance_min  NUMERIC(4,2) NOT NULL DEFAULT 7.0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  -- 'country' for now; future-proofed for 'entity' / 'keyword'.
  target_type     TEXT NOT NULL CHECK (target_type IN ('country', 'entity', 'keyword')),
  -- ISO 3166-1 alpha-2 (e.g. 'US') for country, or text token for the
  -- other types. Stored uppercase by convention.
  target_value    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A user can't subscribe to the same target twice.
  UNIQUE (user_id, target_type, target_value)
);

-- Match path: given a thread's primary_nations array, find subscribers.
CREATE INDEX IF NOT EXISTS idx_notif_subs_target
  ON notification_subscriptions (target_type, target_value);


CREATE TABLE IF NOT EXISTS notification_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  -- 'briefing_daily' | 'thread_new' | 'thread_update' | future kinds.
  kind            TEXT NOT NULL,
  -- thread_id / episode_id / etc. — interpreted by `kind`.
  reference_id    BIGINT,
  -- Pre-rendered title + body shown in the notification.
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- Dedup key: prevents duplicate sends for the same logical event.
  -- Format: `${userId}:${kind}:${reference_id}:${YYYY-MM-DD}` or similar.
  dedup_key       TEXT NOT NULL UNIQUE,
  -- Send outcome.
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered       BOOLEAN,
  error_message   TEXT,
  -- Set when the user opens the notification (deep-link handler).
  opened_at       TIMESTAMPTZ,
  -- Bookkeeping for the per-day cap.
  log_date        DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Frequency-cap query: count today's sends for this user.
CREATE INDEX IF NOT EXISTS idx_notif_log_user_date
  ON notification_log (user_id, log_date);

-- Dispatcher resume cursor — find what was sent since last run.
CREATE INDEX IF NOT EXISTS idx_notif_log_sent_at
  ON notification_log (sent_at);


-- ─── auto-update trigger for notification_preferences.updated_at ──────
CREATE OR REPLACE FUNCTION touch_notif_prefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_preferences_touch ON notification_preferences;
CREATE TRIGGER notification_preferences_touch
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION touch_notif_prefs_updated_at();
