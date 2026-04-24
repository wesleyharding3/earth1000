-- Local story threads — schema changes to support the per-country
-- domestic thread builder (localStoryBuilder.js).
--
-- Design:
--   • Every story_thread row now carries a `scope` — 'global' (existing
--     builder output, cross-border / multi-country) or 'local' (new
--     localStoryBuilder output, single-country domestic).
--   • A country_threading_cadence table tracks per-country run cadence
--     (daily / 2-day / weekly / monthly / skip) based on article volume,
--     plus last_ran_at so the cron knows which countries are due today.
--
-- The two builders live in parallel — local threads don't conflict with
-- or merge into global threads. A single article can appear in BOTH a
-- local thread and a global one (e.g. a Pentagon-spending article is
-- domestic US news AND part of a global US-Iran thread).

-- ─── story_threads.scope ──────────────────────────────────────────────
-- 'global' = existing storyThreadBuilder.js output (cross-border)
-- 'local'  = localStoryBuilder.js output (single-country domestic)
ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'global';

-- Composite index to let the global dedup pass scan scope='global' only
-- without touching local rows, and let the local builder filter the same.
CREATE INDEX IF NOT EXISTS idx_story_threads_scope_status
  ON story_threads (scope, status);

CREATE INDEX IF NOT EXISTS idx_story_threads_scope_country
  ON story_threads USING GIN (primary_nations)
  WHERE scope = 'local';

-- ─── country_threading_cadence ────────────────────────────────────────
-- Populated by articleVolumePerCountry.js (one-off, rerun monthly or
-- after fetcher-source changes). The cron reads this to decide which
-- countries are due today.
CREATE TABLE IF NOT EXISTS country_threading_cadence (
  country_id       int PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE,
  iso_code         text NOT NULL,
  avg_articles_per_day numeric(10,2) NOT NULL DEFAULT 0,
  tier             text NOT NULL CHECK (tier IN ('daily','2day','weekly','monthly','skip')),
  -- When this country was last processed by localStoryBuilder. The cron
  -- picks countries whose last_ran_at + tier_interval <= NOW().
  last_ran_at      timestamptz,
  -- Audit: how many articles were seen in the sampling window, and when
  -- the cadence was last recomputed. Helps diagnose "why is X tier=skip?"
  sample_window_days int NOT NULL DEFAULT 30,
  sample_article_count int NOT NULL DEFAULT 0,
  recalibrated_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctc_tier_lastran
  ON country_threading_cadence (tier, last_ran_at NULLS FIRST);

COMMENT ON TABLE country_threading_cadence IS
  'Per-country threading cadence driven by article volume. Populated by articleVolumePerCountry.js; consumed by localStoryBuilder.js.';
