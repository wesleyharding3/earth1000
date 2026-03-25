-- Location briefings: add location columns to briefing_episodes
-- These allow on-demand briefings scoped to a city or country node.

ALTER TABLE briefing_episodes
  ADD COLUMN IF NOT EXISTS location_type  VARCHAR(10),   -- 'city' | 'country' | NULL (global)
  ADD COLUMN IF NOT EXISTS location_id    INTEGER,       -- cities.id or countries.id
  ADD COLUMN IF NOT EXISTS location_name  TEXT;          -- denormalised for fast display

-- Index for cache lookups (same location, last 2 hours)
CREATE INDEX IF NOT EXISTS idx_briefing_location
  ON briefing_episodes (location_type, location_id, generated_at DESC)
  WHERE location_type IS NOT NULL;
