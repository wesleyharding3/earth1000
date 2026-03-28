ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS fetch_tier INTEGER NOT NULL DEFAULT 1
    CHECK (fetch_tier BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS fetch_tier_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fetch_tier_last_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_news_sources_fetch_tier_last_checked
  ON news_sources (fetch_tier, last_checked_at)
  WHERE is_active = true;
