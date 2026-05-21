-- 20260520 — Replace the embedding backfill's partial index with one that
-- actually matches the snapshot query.
--
-- Background: 20260518_pgvector_embeddings.sql created
--   news_articles_embedding_generated_at_idx ON (embedding_generated_at NULLS FIRST)
--     WHERE embedding IS NULL
-- intending to support backfillEmbeddings.js's "rows still needing an
-- embedding" snapshot. But the snapshot query is keyed differently:
--
--   SELECT id FROM news_articles
--    WHERE embedding IS NULL
--      AND published_at > NOW() - INTERVAL '1 day'
--    ORDER BY published_at DESC, id DESC
--    LIMIT 10000
--
-- The old index has no published_at or id column, so the planner either
-- scanned every NULL-embedding entry and heap-fetched each row to check
-- published_at (slow when the backlog is large), or fell back to
-- idx_news_articles_published_recent and heap-checked embedding IS NULL on
-- every recent row. Either way the snapshot blew through the 60s per-query
-- timeout on 2026-05-20 — see cron failure with code 57014.
--
-- This migration replaces it with a covering partial index that matches
-- the actual query shape: ordered by (published_at DESC, id) so the
-- snapshot is an index-only range scan, no heap fetches, no sort.
--
-- The old index is dropped because nothing else queries by
-- embedding_generated_at — it was bloat-prone (every successful UPDATE
-- killed and re-inserted entries on its key column) and structurally
-- useless for the only consumer it was created for.
--
-- Note: a prior off-migration manual `CREATE INDEX idx_news_articles_unembedded
-- ON news_articles (id DESC) WHERE embedding IS NULL` exists in production
-- (named the same thing the Fix A commit message described). That index is
-- missing published_at, so the planner can't use it for our predicate
-- without a 3.7M-entry heap probe and falls back to idx_articles_published_at
-- instead — which works (10s) but is not the optimum we want. We drop and
-- recreate so production matches the migration's intent and the planner has
-- a covering option.
--
-- Safe to re-run: every statement is guarded by IF [NOT] EXISTS / CONCURRENTLY.

DROP INDEX CONCURRENTLY IF EXISTS idx_news_articles_unembedded;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_unembedded
  ON news_articles (published_at DESC, id)
  WHERE embedding IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS news_articles_embedding_generated_at_idx;

ANALYZE news_articles;
