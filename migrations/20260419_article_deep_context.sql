-- 20260419_article_deep_context.sql
--
-- Consolidate deepAnalyzer + briefingGenerator deep enrichment into one
-- per-article table. Both pipelines previously scraped + Claude-called
-- independently:
--
--   deepAnalyzer.js
--     scrape → Haiku → sentiment_score (+ article_entities table nobody reads)
--   briefingGenerator._deepEnrichThread
--     scrape → Haiku → thread.deepContext (transient, never persisted)
--
-- After this migration, a single module (articleDeepEnrichment.js) does
-- the scrape + Haiku call once per article and writes the structured
-- output here. Both consumers read from this table.
--
-- Columns:
--   article_id       — FK to news_articles, ON DELETE CASCADE so pruning
--                      stays automatic
--   keywords         — 5-10 substantive terms beyond the headline
--   entities         — jsonb array of {text, type, relevance}. Shape
--                      matches the legacy article_entities row format so
--                      migration is a one-time INSERT ... SELECT.
--   relationships    — 2-3 concrete cause-effect statements
--   background       — 1-2 sentences of geopolitical/historical context
--   primary_nations  — ISO-2 codes central to the story, ordered by
--                      centrality. Tees up populating story_threads
--                      .primary_nations at thread-creation time (fix #2
--                      from the thread-builder audit — currently NULL
--                      on every builder-created thread, forcing the
--                      flow-arc + flag-chip code to fall back to noisy
--                      entity-mention extraction).
--   scrape_source    — 'scrape' | 'content_col' | 'summary' — which
--                      fallback tier produced the text Claude saw. Diag.
--   analyzed_at      — timestamp of last analysis
--
-- article_entities (legacy) is NOT dropped here — dbPruneCron.js
-- references it for cascade cleanup, and old rows are still valid as a
-- historical record. Deprecated and no longer written to.

CREATE TABLE IF NOT EXISTS article_deep_context (
  article_id       bigint PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
  keywords         text[]        NOT NULL DEFAULT '{}',
  entities         jsonb         NOT NULL DEFAULT '[]'::jsonb,
  relationships    text[]        NOT NULL DEFAULT '{}',
  background       text,
  primary_nations  text[]        NOT NULL DEFAULT '{}',
  scrape_source    text,
  analyzed_at      timestamptz   NOT NULL DEFAULT now()
);

-- Most queries read by article_id PK (implicit index). Add a recency
-- index for "what's been analyzed in the last N hours" style diagnostics
-- and for post-hoc backfill scans.
CREATE INDEX IF NOT EXISTS idx_article_deep_context_analyzed_at
  ON article_deep_context (analyzed_at DESC);

-- Helpful for counting / backfilling by primary_nations coverage.
CREATE INDEX IF NOT EXISTS idx_article_deep_context_primary_nations
  ON article_deep_context USING GIN (primary_nations);

COMMENT ON TABLE article_deep_context IS
  'Per-article deep enrichment from Claude Haiku. Single source of truth for keywords, entities, relationships, background context, and primary_nations ISO codes. Written by articleDeepEnrichment.js; read by storyThreadBuilder (for thread.primary_nations inference) and briefingGenerator (for voiceover context). Replaces the write-only article_entities table and the transient thread.deepContext that briefings used to re-scrape for.';

COMMENT ON COLUMN article_deep_context.primary_nations IS
  'ISO-3166 alpha-2 codes, ordered by centrality to the story. Used by the thread builder to populate story_threads.primary_nations (previously NULL, forcing noisy entity-mention fallback for flag chips and flow arcs).';
