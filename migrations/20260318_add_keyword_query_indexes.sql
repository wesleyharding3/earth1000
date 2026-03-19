-- Run this file with psql, not inside a transaction, because the indexes are
-- created CONCURRENTLY to avoid blocking writes on large keyword tables.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kds_global_date_keyword_cover
  ON keyword_daily_stats (date DESC, keyword)
  INCLUDE (total_count, language_group_count)
  WHERE source_country_id IS NULL AND about_country_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kds_about_date_keyword_cover
  ON keyword_daily_stats (about_country_id, date DESC, keyword)
  INCLUDE (total_count, language_group_count);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kds_source_date_keyword_cover
  ON keyword_daily_stats (source_country_id, date DESC, keyword)
  INCLUDE (total_count, language_group_count);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_keywords_lower_keyword_prefix
  ON article_keywords (LOWER(keyword) text_pattern_ops);
