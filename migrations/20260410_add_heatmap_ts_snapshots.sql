-- Pre-aggregated time-bucketed heatmap snapshots.
-- The /api/heatmap endpoint reads from this table for standard time-series
-- requests (no keyword/thread_id/custom date range), avoiding expensive
-- GROUP BY date_trunc(...) scans on news_articles.
-- Refreshed every 10-15 min via Render cron alongside flat snapshots.
--
-- Presets: 1d_hour, 1d_day, 3d_hour, 3d_day, 7d_day, 14d_day
-- (7d_hour / 14d_hour remain live-query — too many rows to pre-compute)

CREATE TABLE IF NOT EXISTS heatmap_ts_snapshots (
  id            SERIAL PRIMARY KEY,
  preset        TEXT NOT NULL,                    -- '1d_hour', '7d_day', etc.
  level         TEXT NOT NULL CHECK (level IN ('country', 'city')),
  bucket_time   TIMESTAMPTZ NOT NULL,             -- date_trunc'd bucket timestamp
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
  UNIQUE (preset, level, bucket_time, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_heatmap_ts_snapshots_lookup
  ON heatmap_ts_snapshots (preset, level, bucket_time);
