-- Run with psql, NOT inside a transaction (CONCURRENTLY rejects it).
--
-- Partial covering index for keywordNormalizer.js's candidate query.
--
-- Without this index the query did a full sequential scan of
-- article_keywords (millions of rows) every cron run, taking ~5.4
-- minutes — just past the 5-min statement_timeout, so production
-- failed every night.
--
-- The index is keyed by article_id (cheap to join from news_articles)
-- and INCLUDEs the columns the query selects (keyword, source_language,
-- frequency) so the planner can answer the candidate scan with an
-- index-only scan, no heap touch.
--
-- WHERE clause restricts the index to rows that are actually candidates
-- for normalization — un-normalized + non-English + valid length.
-- Most article_keywords rows are NOT candidates (already normalized,
-- or English source), so this index stays small (~10–15% of the table)
-- and selective.
--
-- Result on the live DB: 30h candidate query dropped from 323s → 30s.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ak_pending_normalization
  ON article_keywords (article_id)
  INCLUDE (keyword, source_language, frequency)
  WHERE normalized_keyword IS NULL
    AND source_language IS DISTINCT FROM 'en'
    AND keyword IS NOT NULL
    AND LENGTH(keyword) >= 3;

ANALYZE article_keywords;
