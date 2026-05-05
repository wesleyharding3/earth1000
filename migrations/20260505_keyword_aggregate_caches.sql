-- Pre-aggregated, rolling-window caches for keyword-filtered heatmap and
-- flows queries.
--
-- Why: /api/heatmap?keyword=X and /api/flows?keyword=X (aggregate, country
-- view) currently scan news_articles + article_keywords from scratch on
-- every cold-cache miss. Hot keywords ("trump", "ai", "iran") regularly
-- exceed the 60s prewarm SQL timeout. The unfiltered heatmap path is
-- already fast because heatmap_snapshots pre-aggregates it; this migration
-- adds the equivalent aggregation for the keyword-filtered case.
--
-- Update model: aggregateKeywordCacheCron.js refreshes today + yesterday
-- on every run (~5 min cadence) to absorb late-arriving articles, and
-- back-fills any missing past days inside the rolling window once. Days
-- older than the window are pruned by the same cron.

BEGIN;

-- ── Heatmap country layer ──────────────────────────────────────────────────
-- Mirrors the live heatmap query's country-row group:
--   FROM news_articles a JOIN countries c ON c.id = a.country_id
--   WHERE keyword matches AND a.country_id IS NOT NULL AND a.city_id IS NULL
--   GROUP BY c.id
CREATE TABLE IF NOT EXISTS public.keyword_country_daily (
  keyword       TEXT NOT NULL,
  day_bucket    DATE NOT NULL,
  country_id    INT  NOT NULL,
  n             INT  NOT NULL DEFAULT 0,
  sent_n        INT  NOT NULL DEFAULT 0,
  sent_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (keyword, day_bucket, country_id)
);

CREATE INDEX IF NOT EXISTS idx_kcd_keyword_day
  ON public.keyword_country_daily (keyword, day_bucket DESC);

-- ── Heatmap city layer ─────────────────────────────────────────────────────
-- Mirrors the live heatmap query's city-row group:
--   FROM news_articles a JOIN cities ci ON ci.id = a.city_id
--   WHERE keyword matches AND a.city_id IS NOT NULL
--   GROUP BY ci.id
CREATE TABLE IF NOT EXISTS public.keyword_city_daily (
  keyword       TEXT NOT NULL,
  day_bucket    DATE NOT NULL,
  city_id       INT  NOT NULL,
  country_id    INT  NOT NULL,
  n             INT  NOT NULL DEFAULT 0,
  sent_n        INT  NOT NULL DEFAULT 0,
  sent_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (keyword, day_bucket, city_id)
);

CREATE INDEX IF NOT EXISTS idx_kcyd_keyword_day
  ON public.keyword_city_daily (keyword, day_bucket DESC);

-- ── Flows aggregate country-view ───────────────────────────────────────────
-- Mirrors flows aggregate query's country-view grouping. We preserve city
-- granularity even in country view because the live endpoint renders cities
-- when a.city_id IS NOT NULL — mirror that exactly so cached results match
-- live results byte-for-byte. city_id = 0 sentinel = no city (country-only
-- article).
CREATE TABLE IF NOT EXISTS public.keyword_flows_daily (
  keyword           TEXT NOT NULL,
  day_bucket        DATE NOT NULL,
  src_country_id    INT  NOT NULL,
  src_city_id       INT  NOT NULL DEFAULT 0,
  dst_country_id    INT  NOT NULL,
  dst_city_id       INT  NOT NULL DEFAULT 0,
  n                 INT  NOT NULL DEFAULT 0,
  sent_n            INT  NOT NULL DEFAULT 0,
  sent_sum          DOUBLE PRECISION NOT NULL DEFAULT 0,
  source_routes     INT  NOT NULL DEFAULT 0,
  content_routes    INT  NOT NULL DEFAULT 0,
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (keyword, day_bucket, src_country_id, src_city_id, dst_country_id, dst_city_id)
);

CREATE INDEX IF NOT EXISTS idx_kfd_keyword_day
  ON public.keyword_flows_daily (keyword, day_bucket DESC);

COMMIT;
