-- ─── Payment provider columns on subscriptions ────────────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider          TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_sub_id   TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_cus_id   TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW();

-- ─── Ensure subscription_tiers rows exist ─────────────────────────────────
INSERT INTO subscription_tiers (name, display_name)
  SELECT 'free', 'Free'
  WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'free');

INSERT INTO subscription_tiers (name, display_name)
  SELECT 'pro', 'Pro'
  WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'pro');

INSERT INTO subscription_tiers (name, display_name)
  SELECT 'enterprise', 'Enterprise'
  WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'enterprise');

-- ─── Daily usage counters (translations + AI explanations) ────────────────
CREATE TABLE IF NOT EXISTS user_usage (
  user_id      UUID    NOT NULL,
  usage_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
  translations INTEGER NOT NULL DEFAULT 0,
  explanations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY  (user_id, usage_date)
);

-- ─── Briefing access log — tracks which episodes a user has opened ─────────
-- Used to enforce the free-tier 2-briefings-per-week cap.
CREATE TABLE IF NOT EXISTS briefing_access_log (
  user_id     UUID    NOT NULL,
  episode_id  INTEGER NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, episode_id)
);

-- ─── Monthly custom briefing usage (for enterprise cap) ───────────────────
CREATE TABLE IF NOT EXISTS custom_briefing_usage (
  user_id     UUID    NOT NULL,
  usage_month TEXT    NOT NULL,  -- 'YYYY-MM'
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_month)
);

-- ─── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_usage_date    ON user_usage (user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_briefing_access_ts ON briefing_access_log (user_id, accessed_at);
