-- Speed up /api/flows aggregate + individual queries.
--
-- Hot path: article_locations al JOIN news_articles a ON a.id = al.article_id
-- WHERE al.routing_type IN ('content','source') AND a.published_at > NOW() - '7 days'
--
-- Existing indexes are keyed by (city_id|country_id, routing_type, article_id).
-- Those help when a place filter is applied. When the request has no place
-- filter (the default country aggregate that the warmer hits), the planner
-- can't use them and falls back to a big hash/seq pattern — exactly the case
-- that blows past a 6s statement timeout on cold buffers.
--
-- Below:
--   1. article_locations(routing_type, article_id) — drives the unfiltered
--      route scan, supports the join to news_articles on article_id.
--   2. news_articles(published_at DESC, id) — partial on last 14 days so the
--      date window filter is an index-only lookup. 14d rolling window covers
--      the 7d default plus slack for the scheduled prune.
--
-- All CONCURRENTLY + IF NOT EXISTS: safe to re-run, no write lock.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_locations_route_article
  ON article_locations (routing_type, article_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_published_recent
  ON news_articles (published_at DESC, id)
  WHERE published_at > '2026-04-03'::timestamp;
-- Note: the WHERE-clause date is a static cutoff. Postgres won't recompute
-- NOW() for a partial predicate, so this partial index covers a fixed
-- trailing window. Re-create quarterly (or whenever coverage drops) to keep
-- it matched to the rolling 7d query filter.

ANALYZE article_locations;
ANALYZE news_articles;
