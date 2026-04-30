-- ─────────────────────────────────────────────────────────────────────
-- User retention foundation: daily streaks + per-surface last-seen.
--
-- Two tables, narrow scope, both keyed on auth.users.id (UUID coming
-- from Supabase). No FK to a non-existent local users table — Supabase
-- IS the user system; we just hold the bookkeeping rows alongside.
--
--   user_streaks       — one row per user. Tracks current/longest streak
--                        in days, last_active_date (in user-local TZ as
--                        a DATE so DST and tz changes don't double-tick),
--                        and a small "freeze" budget so a single missed
--                        day doesn't reset a 30-day streak.
--
--   user_last_seen     — per (user, surface) timestamp. Surfaces are
--                        free-form strings ('threads', 'lines', etc.)
--                        so we can add new badged surfaces without a
--                        schema change. Used to compute "N new since
--                        you last visited" counts.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_streaks (
  user_id           UUID PRIMARY KEY,
  current_streak    INT  NOT NULL DEFAULT 0,
  longest_streak    INT  NOT NULL DEFAULT 0,
  -- DATE (no time) so a user opening the app at 11:59pm and again at
  -- 12:01am gets counted as TWO active days, not one. Stored in the
  -- user's local timezone — the client passes a YYYY-MM-DD string from
  -- its own clock, server trusts it. (Trivial fraud surface — gaming
  -- your own streak counter is harmless.)
  last_active_date  DATE,
  -- Per-week budget of "freezes" — a freeze lets a user skip a single
  -- day without breaking their streak. Resets when freeze_week_start
  -- crosses to a new ISO week. Default 1 freeze/week, configurable
  -- via app code, not schema.
  freezes_used      INT  NOT NULL DEFAULT 0,
  freeze_week_start DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cheap lookup for any future "leaderboards" / streak-based feed
-- prioritization (none yet, but this index is free at our scale).
CREATE INDEX IF NOT EXISTS idx_user_streaks_current_streak
  ON user_streaks (current_streak DESC);


CREATE TABLE IF NOT EXISTS user_last_seen (
  user_id      UUID NOT NULL,
  -- Free-form. Current values: 'threads', 'lines', 'briefing'. Add
  -- new ones in the application without migrations.
  surface      TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, surface)
);

CREATE INDEX IF NOT EXISTS idx_user_last_seen_user
  ON user_last_seen (user_id);
