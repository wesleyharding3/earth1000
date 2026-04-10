-- Pre-aggregated heatmap snapshots.
-- The /api/heatmap endpoint reads from this table for standard requests
-- (no keyword/thread_id/custom date range/bucket), avoiding 300k+ row scans
-- on news_articles. Refreshed every 10-15 min via Render cron.

CREATE TABLE IF NOT EXISTS heatmap_snapshots (
  id            SERIAL PRIMARY KEY,
  preset        TEXT NOT NULL,                    -- '1d', '7d', '30d', '90d'
  level         TEXT NOT NULL CHECK (level IN ('country', 'city')),
  ref_id        INT  NOT NULL,                    -- country_id or city_id
  country_id    INT,
  iso           TEXT,
  country_name  TEXT,
  name          TEXT NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  n             INT NOT NULL DEFAULT 0,
  sent_n        INT NOT NULL DEFAULT 0,
  avg_sent      DOUBLE PRECISION,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (preset, level, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_heatmap_snapshots_lookup
  ON heatmap_snapshots (preset, level);

-- ── Critical missing indexes for thread/timeline queries ──────────────
-- story_thread_articles.thread_id is used in virtually every thread
-- endpoint (hero images, flow arcs, article lists, country counts).
-- Without this, Postgres does a seq scan on every lookup.
CREATE INDEX IF NOT EXISTS idx_story_thread_articles_thread_id
  ON story_thread_articles (thread_id);

CREATE INDEX IF NOT EXISTS idx_story_thread_articles_article_id
  ON story_thread_articles (article_id);

-- Same for timeline articles
CREATE INDEX IF NOT EXISTS idx_story_timeline_articles_timeline_id
  ON story_timeline_articles (timeline_id);

CREATE INDEX IF NOT EXISTS idx_story_timeline_articles_article_id
  ON story_timeline_articles (article_id);

-- story_threads status + article_count for the main feed query
CREATE INDEX IF NOT EXISTS idx_story_threads_feed
  ON story_threads (status, importance DESC, article_count DESC, last_updated_at DESC)
  WHERE article_count >= 2 AND status IN ('active', 'cooling', 'dormant');
