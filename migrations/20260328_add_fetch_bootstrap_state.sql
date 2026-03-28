ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_phase TEXT NOT NULL DEFAULT 'baseline'
    CHECK (fetch_bootstrap_phase IN ('baseline', 'tier3_eval', 'tier4_eval', 'stable')),
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_baseline_runs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_baseline_empty_runs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_tier3_runs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_tier3_empty_runs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_tier4_runs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetch_bootstrap_tier4_empty_runs INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_news_sources_fetch_bootstrap_phase
  ON news_sources (fetch_bootstrap_phase, last_checked_at)
  WHERE is_active = true;
