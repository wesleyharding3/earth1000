-- Speed up /api/flows/thread/:id and /api/flows/timeline/:id
--
-- These endpoints join 4 tables:
--   story_thread_articles × article_entity_mentions × entities × countries
--
-- Symptom: cold Postgres buffer cache → query > 45s → pool statement_timeout
-- → 500. Client retries, DB is now warm, query finishes in <1s. Classic
-- "fails first, works second" pattern.
--
-- Indexes below target the hot access paths exposed by the query:
--
--   1. Partial index on article_entity_mentions that encodes the exact WHERE
--      filter (role IN (…) AND confidence >= 0.6). Because entity_id is in the
--      index, Postgres can do an index-only scan — no heap fetch per mention.
--      Dramatically smaller than a full (article_id, entity_id) index since
--      only ~30% of mention rows match the hot role/confidence predicate.
--
--   2. Expression indexes on entities(LOWER(country_code)) and
--      countries(LOWER(iso_code)). The current JOIN uses
--      `LOWER(co.iso_code) = LOWER(e.country_code)` which disqualifies any
--      regular btree index on those columns. Expression indexes restore the
--      ability to index-lookup. (Longer-term fix: normalize case at write
--      time and drop the LOWER() — but that's a data migration.)
--
--   3. Partial index on entities for entity_type='location' lookups, since
--      the planner may want to drive from entities in some thread topologies.
--
-- All CREATE INDEX CONCURRENTLY IF NOT EXISTS → safe to re-run, won't lock
-- writes, won't error if already present.
--
-- ── BEFORE/AFTER verification ────────────────────────────────────────────
-- Run these on a representative thread (find one with `SELECT id FROM
-- story_threads WHERE status='active' ORDER BY article_count DESC LIMIT 5;`):
--
--   -- Baseline: clear buffers and measure cold
--   DISCARD ALL;
--   EXPLAIN (ANALYZE, BUFFERS) SELECT ...  -- the thread flows query
--
--   -- Re-run after indexes exist
--   EXPLAIN (ANALYZE, BUFFERS) SELECT ...
--
-- Expected: total time 30-60s cold → 0.5-2s cold, and buffer hits drop by
-- 10-50×. Warm cache already fine pre-existing; this migration is about
-- cold-path resilience.

-- ── 1. Hot partial index on article_entity_mentions ─────────────────────
-- Covers the exact WHERE filter, supports index-only scan on (article_id, entity_id).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aem_hot_flow_arcs
  ON article_entity_mentions (article_id, entity_id)
  WHERE role IN ('subject','actor','location')
    AND confidence >= 0.6;

-- ── 2. Expression indexes for case-insensitive country_code/iso_code JOIN ─
-- Unlocks index lookup on the LOWER(...) = LOWER(...) join predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_country_code_lower
  ON entities (LOWER(country_code))
  WHERE country_code IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_countries_iso_code_lower
  ON countries (LOWER(iso_code))
  WHERE iso_code IS NOT NULL;

-- ── 3. Partial index for entity_type='location' lookups ──────────────────
-- Useful if the planner chooses to drive from entities for very small threads.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_location_country
  ON entities (country_code, id)
  WHERE entity_type = 'location' AND country_code IS NOT NULL;

-- ── 4. story_thread_articles / story_timeline_articles lookups ───────────
-- Most likely these already exist (FK indexes or PKs), but assert them so
-- the migration is self-contained. IF NOT EXISTS guards against duplicates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sta_thread_id
  ON story_thread_articles (thread_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stla_timeline_id
  ON story_timeline_articles (timeline_id);

-- After this migration is applied, ANALYZE the affected tables so the
-- planner's statistics reflect the new indexes:
--   ANALYZE article_entity_mentions;
--   ANALYZE entities;
--   ANALYZE countries;
--   ANALYZE story_thread_articles;
--   ANALYZE story_timeline_articles;
