CREATE INDEX IF NOT EXISTS idx_news_articles_city_published_at
  ON news_articles (city_id, published_at DESC, id DESC)
  WHERE city_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_articles_country_local_published_at
  ON news_articles (country_id, published_at DESC, id DESC)
  WHERE city_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_article_tags_tag_article_score
  ON article_tags (tag_id, article_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_article_locations_city_route_article
  ON article_locations (city_id, routing_type, article_id);

CREATE INDEX IF NOT EXISTS idx_article_locations_country_route_article
  ON article_locations (country_id, routing_type, article_id);
