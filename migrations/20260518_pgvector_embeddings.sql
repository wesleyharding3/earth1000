-- 20260518 — Enable pgvector and add per-article semantic embeddings.
--
-- Purpose: lets storyThreadBuilder (and future clustering jobs) replace the
-- expensive Claude singleton-batch path with nearest-neighbor search over
-- precomputed embeddings. See analyzeThreadOrigins.js and the May 18
-- conversation for the rationale (singleton batches were costing ~$5/day
-- for ~70 threads/wk of dubious quality; embeddings give same-event
-- clustering at ~$0/day local compute).
--
-- Embedding column shape: vector(384) — chosen to match
-- Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384 dim, multilingual,
-- ~470MB on disk, runs on CPU). If we switch to a 768-dim model later
-- we'll need a follow-up migration.
--
-- We intentionally do NOT create the HNSW index here. HNSW build time is
-- O(N log N) and on a multi-million-row table can run hours. Backfill the
-- column first via backfillEmbeddings.js, then create the index with
-- CONCURRENTLY in a follow-up migration once population is steady-state.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS embedding vector(384);

-- Track when each row's embedding was generated. Lets the embedder skip
-- rows that are already done without scanning the (huge) vector column,
-- and lets us re-embed everything after a model upgrade by clearing
-- this timestamp on rows we want to regenerate.
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

-- Cheap btree index on the new timestamp so the embedder's "rows with
-- NULL embedding" query stays fast as the table grows.
CREATE INDEX IF NOT EXISTS news_articles_embedding_generated_at_idx
  ON news_articles (embedding_generated_at NULLS FIRST)
  WHERE embedding IS NULL;
