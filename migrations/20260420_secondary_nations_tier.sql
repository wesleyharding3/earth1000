-- ═══════════════════════════════════════════════════════════════════════════
--  Secondary-tier nations for thread/line flow-arc tiering
--
--  Context (v3 thread graduation model):
--    primary_nations on story_threads / story_timelines was historically
--    populated with every country appearing as subject/actor across the
--    thread's articles. That list ran over-populated: a Russia-Ukraine
--    thread ended up with 7+ "primary" countries (US/DE/FR/IL/...) when
--    the real story is about just RU and UA.
--
--    We now split the curated candidate set into TWO tiers:
--      - primary_nations    — 1-3 countries the story is fundamentally about
--      - secondary_nations  — up to 8 supporters, commenters, affected parties
--
--    Flow-arc rendering for threads and lines uses this split to draw a
--    green mesh among primaries and a light-blue spider from primaries
--    to secondaries. Article flow arcs + News Flows are unchanged — still
--    article-routing based.
--
--  Populated by: entityTierClassifier.js (Claude Haiku) at thread/line
--    persistence time; backfilled via --reclassify-actors sweep.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS secondary_nations TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE story_timelines
  ADD COLUMN IF NOT EXISTS secondary_nations TEXT[] NOT NULL DEFAULT '{}';

-- GIN indexes so flow-arc endpoints can lookup by ISO without a seq scan.
-- The primary_nations GIN index already exists (or should); mirror here.
CREATE INDEX IF NOT EXISTS idx_story_threads_secondary_nations
  ON story_threads USING GIN (secondary_nations);

CREATE INDEX IF NOT EXISTS idx_story_timelines_secondary_nations
  ON story_timelines USING GIN (secondary_nations);
