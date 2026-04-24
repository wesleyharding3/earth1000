-- Run with psql, NOT inside a transaction (CONCURRENTLY rejects it).
--
-- These indexes accelerate the thread-flow country aggregation used by
--   /api/flows/thread/:id  (server.js:_buildTieredFlows)
--   /api/flows/timeline/:id (same function, shared path)
--
-- Problem: the hot aggregation joins
--   story_thread_articles ⨝ article_entity_mentions ⨝ entities
-- and then filters entities by
--   entity_type = 'location' AND country_code = ?
--
-- The existing idx_entities_type is broad (every entity of every type);
-- the planner then scans every location entity and filters country_code
-- row-by-row. For large threads this blew past the 45s fetch ceiling
-- the frontend enforces and the client aborted.
--
-- Fix: a partial index keyed on country_code restricted to location
-- rows. Planner goes straight from "entity_type='location' AND
-- country_code='US'" to the tiny matching set.

-- Primary index: the AEM → entities lookup filter.
-- country_code normalised to UPPER() to match the query's
-- `UPPER(e.country_code) = f.iso_upper` predicate without forcing a
-- functional scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_location_country
  ON entities (UPPER(country_code))
  WHERE entity_type = 'location' AND country_code IS NOT NULL;

-- Covering index on AEM for the location → article path. article_id is
-- already indexed; this one adds entity_id with a role filter so the
-- planner can skip non-subject/actor mentions when the legacy fallback
-- path runs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aem_entity_role_conf
  ON article_entity_mentions (entity_id, role, confidence)
  WHERE role IN ('subject', 'actor');

ANALYZE entities;
ANALYZE article_entity_mentions;
