-- Covering indexes for /api/heatmap v2 queries.
--
-- Post-refactor the heatmap joins directly on news_articles.country_id and
-- news_articles.city_id, filtered by published_at. Without these partial
-- indexes the query can hit statement_timeout (60s) on the Render host and
-- return HTTP 500 on mobile clients that hit the endpoint during bursts.

-- Country wash query: published_at + country_id IS NOT NULL + city_id IS NULL
CREATE INDEX IF NOT EXISTS idx_news_articles_country_wash_published
  ON news_articles (country_id, published_at DESC)
  WHERE country_id IS NOT NULL AND city_id IS NULL;

-- City cluster query: published_at + city_id IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_news_articles_city_cluster_published
  ON news_articles (city_id, published_at DESC)
  WHERE city_id IS NOT NULL;

-- Generic accelerator for aggregate date-range scans used by both queries
CREATE INDEX IF NOT EXISTS idx_news_articles_published_at_brin
  ON news_articles USING BRIN (published_at);
