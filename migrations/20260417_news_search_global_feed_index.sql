-- Speed up /api/news/search default-path Tier 1/2/3 cold queries.
--
-- Hot filter (all three tiers):
--   WHERE city_id IS NULL
--     AND published_at > NOW() - INTERVAL 'N hours'   (24h/48h/72h by tier)
--     AND COALESCE(base_priority, 0) > 0.05
--
-- Without a matching index Postgres scans news_articles, sorts by the
-- computed _rank, and applies LIMIT — fine on warm buffers, blows past
-- statement_timeout on cold ones (the cause of the 500s the user just hit).
--
-- Partial index on city_id IS NULL because the global feed never queries
-- city-level rows — keeps the index small and lets the planner skip the
-- city_id check entirely. (published_at DESC, base_priority) lets the
-- 72h range scan finish quickly and pre-filters base_priority on the
-- index before touching the heap.
--
-- _rank itself isn't index-orderable (it's a computed expression), but
-- once the candidate set is reduced from millions to ~thousands by the
-- time+priority filter, the in-memory sort is cheap.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_global_feed
  ON news_articles (published_at DESC, base_priority)
  WHERE city_id IS NULL;

ANALYZE news_articles;
