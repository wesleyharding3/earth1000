-- 20260409_story_timelines_and_thread_recast.sql
--
-- Introduces the "Timelines" category and recasts the existing
-- `story_threads` table into the new "breaking meta-story" role.
--
-- Conceptual split:
--
--   Timelines  → broad, 7-day lookback with parabolic weighting (peak ≈ 24h)
--                that groups umbrella arcs ("Iran war", "Venezuela / Maduro
--                succession") into a single living lane. Sources the tier 3/4
--                long-tail in addition to high-scoring tier 1/2 articles.
--
--   Threads    → tight, 48h lifecycle. Surfaces the "meta-story" that the
--                world's press collectively foregrounds right now via
--                cross-source signal convergence (≥3 distinct sources in 24h).
--                Shares the `story_threads` storage — we just add convergence
--                columns and change the builder's semantics.
--
-- This migration is additive. Existing data in `story_threads` stays in
-- place; the new columns default to NULL / 0 and the builder will populate
-- them on the next run.

-- ─── story_threads: breaking-signal columns ──────────────────────────────────
ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS breaking_signal_score REAL,
  ADD COLUMN IF NOT EXISTS distinct_source_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_breaking_ping_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_story_threads_breaking_signal
  ON story_threads (breaking_signal_score DESC NULLS LAST)
  WHERE status = 'active';


-- ─── story_timelines ─────────────────────────────────────────────────────────
-- Mirrors story_threads in shape so the frontend rendering code can treat
-- timeline cards and thread cards uniformly. Adds timeline-specific columns:
--
--   scope                — stable slug for the umbrella arc ("iran_war")
--   lookback_days        — how far back the builder considered (default 7)
--   parabolic_peak_hours — age bucket the weighting favored most (default 24)
--   historical_anchors   — JSONB array of referenced_date rows from the
--                          entity groundwork tables; rendered as pinned
--                          markers on the timeline panel.

CREATE TABLE IF NOT EXISTS story_timelines (
  id                    SERIAL PRIMARY KEY,
  title                 TEXT        NOT NULL,
  description           TEXT,
  scope                 TEXT,                 -- e.g. "iran_war", "venezuela_maduro"
  status                TEXT        NOT NULL DEFAULT 'active',
  importance            DOUBLE PRECISION DEFAULT 5,
  primary_category      TEXT,
  geographic_scope      TEXT        DEFAULT 'global',
  keywords              TEXT[]      NOT NULL DEFAULT '{}',
  article_count         INT         NOT NULL DEFAULT 0,
  distinct_source_count INT         NOT NULL DEFAULT 0,
  lookback_days         INT         NOT NULL DEFAULT 7,
  parabolic_peak_hours  INT         NOT NULL DEFAULT 24,
  parabolic_weight_sum  REAL        NOT NULL DEFAULT 0,
  historical_anchors    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_story_timelines_status_updated
  ON story_timelines (status, last_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_timelines_scope
  ON story_timelines (scope)
  WHERE scope IS NOT NULL;

-- scope is the merge key for backfill + scheduled builder upserts, so it
-- must be unique. Added in a DO block so re-running the migration is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'story_timelines_scope_unique'
  ) THEN
    ALTER TABLE story_timelines
      ADD CONSTRAINT story_timelines_scope_unique UNIQUE (scope);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_story_timelines_keywords_gin
  ON story_timelines USING GIN (keywords);

CREATE INDEX IF NOT EXISTS idx_story_timelines_importance
  ON story_timelines (importance DESC, last_updated_at DESC)
  WHERE status = 'active';


-- ─── story_timeline_articles ────────────────────────────────────────────────
-- Junction table. `parabolic_weight` is the age-based weight the builder
-- assigned this article (0 at edges → ~1.0 near the 24h peak); used during
-- ranking when surfacing a timeline's hero article / most-signal article.

CREATE TABLE IF NOT EXISTS story_timeline_articles (
  timeline_id       INT         NOT NULL REFERENCES story_timelines(id) ON DELETE CASCADE,
  article_id        INT         NOT NULL REFERENCES news_articles(id)    ON DELETE CASCADE,
  parabolic_weight  REAL        NOT NULL DEFAULT 0,
  relevance_score   REAL        NOT NULL DEFAULT 0,
  is_anchor         BOOLEAN     NOT NULL DEFAULT FALSE,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (timeline_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_sta_timeline  ON story_timeline_articles (timeline_id);
CREATE INDEX IF NOT EXISTS idx_sta_article   ON story_timeline_articles (article_id);
CREATE INDEX IF NOT EXISTS idx_sta_anchor
  ON story_timeline_articles (timeline_id)
  WHERE is_anchor = TRUE;
