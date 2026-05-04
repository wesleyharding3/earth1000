-- Materialized views for keyword intelligence.
--
-- Replaces the in-cron heavy aggregation in keywordCron.js (rising +
-- trending). Both queries scan keyword_daily_stats over a 7–17-day window
-- with GROUP BY keyword, FILTER aggregates, and a NOT EXISTS anti-join
-- against the 26k-row stopwords table. The base-table aggregation has
-- grown past the 300s statement_timeout — see Render Cron failures for
-- npm run cron:kw-intel-rising.
--
-- These MVs persist the per-keyword aggregation. The crons then become
--   1) REFRESH MATERIALIZED VIEW (heavy, but no statement_timeout)
--   2) Cheap SELECT with stopwords anti-join + ORDER BY + LIMIT
--   3) Write top-N to keyword_intelligence_cache
-- See keywordCron.js for the matching read path.
--
-- Created WITH NO DATA so the first cron run populates them. Unique
-- indexes on (keyword) enable REFRESH MATERIALIZED VIEW CONCURRENTLY in
-- the future if we want non-blocking refresh; current crons use plain
-- REFRESH (locks briefly, fine for a once-daily cron with no live read
-- traffic on the MVs).

BEGIN;

-- ── Trending: top mentions over last 7 days, global slice ───────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.keyword_trending_global AS
SELECT
  k.keyword,
  SUM(k.total_count)::bigint  AS mentions,
  COUNT(DISTINCT k.date)::int AS days_active
FROM public.keyword_daily_stats k
WHERE k.date              >= CURRENT_DATE - 7
  AND k.source_country_id IS NULL
  AND k.about_country_id  IS NULL
GROUP BY k.keyword
HAVING SUM(k.total_count) >= 3
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS keyword_trending_global_pk
  ON public.keyword_trending_global (keyword);
CREATE INDEX IF NOT EXISTS keyword_trending_global_mentions_idx
  ON public.keyword_trending_global (mentions DESC);

-- ── Rising: per-keyword recent vs baseline counts + momentum, 17-day ────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.keyword_rising_global AS
WITH combined AS (
  SELECT
    k.keyword,
    SUM(k.total_count) FILTER (WHERE k.date >= CURRENT_DATE - 3)::bigint AS recent_count,
    SUM(k.total_count) FILTER (WHERE k.date <  CURRENT_DATE - 3)::bigint AS baseline_count
  FROM public.keyword_daily_stats k
  WHERE k.date              >= CURRENT_DATE - 17
    AND k.source_country_id IS NULL
    AND k.about_country_id  IS NULL
  GROUP BY k.keyword
  HAVING SUM(k.total_count) FILTER (WHERE k.date >= CURRENT_DATE - 3) >= 2
)
SELECT
  c.keyword,
  c.recent_count,
  COALESCE(c.baseline_count, 0) AS baseline_count,
  CASE
    WHEN COALESCE(c.baseline_count, 0) = 0
      THEN c.recent_count * 10
    ELSE ROUND(
      (c.recent_count::numeric / c.baseline_count::numeric)
      * (14::numeric / 3::numeric) * 100
    ) / 100
  END AS momentum
FROM combined c
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS keyword_rising_global_pk
  ON public.keyword_rising_global (keyword);
CREATE INDEX IF NOT EXISTS keyword_rising_global_momentum_idx
  ON public.keyword_rising_global (momentum DESC);

COMMIT;
