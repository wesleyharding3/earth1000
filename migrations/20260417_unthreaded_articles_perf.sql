-- Speed up storyThreadBuilder's getUnthreadedArticles() query.
--
-- Symptom: cron job was timing out at 120s on the "unthreaded articles"
-- query that scans 48h of news_articles anti-joined against
-- story_thread_articles. The anti-join (LEFT JOIN … WHERE sta.article_id
-- IS NULL, now rewritten as NOT EXISTS) was the bottleneck because
-- story_thread_articles had no lookup-by-article_id index.
--
-- Index below supports the NOT EXISTS subquery in getUnthreadedArticles:
--   SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
-- Also covers the pre-existing flow-arcs path that joins through
-- sta.article_id.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sta_article_id
  ON story_thread_articles (article_id);

-- After applying, refresh planner stats:
--   ANALYZE story_thread_articles;
