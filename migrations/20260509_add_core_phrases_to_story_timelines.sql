-- Adds core_phrases TEXT[] to story_timelines.
--
-- A core_phrase is a distinctive proper noun pulled from the Line's
-- title (e.g. "Gaza", "Ukraine", "Sudan", "Hamas"). Used by the
-- article-umbrella phase as a third pre-filter branch:
--   Branch C: news_articles.title ILIKE '%' || core_phrase || '%'
-- This catches followup coverage that's clearly on-topic but missed
-- the keyword/entity extraction pipeline — the umbrella's structured
-- match (nations + keywords) was rejecting "Israel strikes Gaza" type
-- articles because they only had 1 nation + 1 keyword overlap (3.5,
-- below the 3.0 attach threshold) even though the headline literally
-- says "Gaza".
--
-- Idempotent — safe to re-run.
ALTER TABLE story_timelines
  ADD COLUMN IF NOT EXISTS core_phrases TEXT[] NOT NULL DEFAULT '{}';

-- GIN index so the umbrella phase's ANY() lookup uses an index instead
-- of array unnest. Most lines will have 1-3 phrases; the array is
-- small enough that GIN is overkill performance-wise but keeps query
-- plans simple as the table grows.
CREATE INDEX IF NOT EXISTS idx_story_timelines_core_phrases
  ON story_timelines USING GIN (core_phrases);
