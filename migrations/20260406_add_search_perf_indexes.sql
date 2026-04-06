-- Speed up /api/news/search default query (city_id IS NULL + published_at range)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_nocity_published
  ON news_articles (published_at DESC)
  WHERE city_id IS NULL;

-- Speed up article_image_assignments lookup by article_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_image_assignments_article
  ON article_image_assignments (article_id);

-- Speed up country_feed_boost lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_country_feed_boost_country
  ON country_feed_boost (country_id);
