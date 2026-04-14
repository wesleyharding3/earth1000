-- Add primary_nations column to story_threads and story_timelines.
-- Stores ISO codes of nations mentioned in article titles (not summaries).
-- Editable via the admin editor.

ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS primary_nations TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE story_timelines
  ADD COLUMN IF NOT EXISTS primary_nations TEXT[] NOT NULL DEFAULT '{}';

-- GIN indexes for fast array lookups
CREATE INDEX IF NOT EXISTS idx_story_threads_primary_nations_gin
  ON story_threads USING GIN (primary_nations);

CREATE INDEX IF NOT EXISTS idx_story_timelines_primary_nations_gin
  ON story_timelines USING GIN (primary_nations);
