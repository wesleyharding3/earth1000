-- 20260407_story_thread_dormant_status.sql
--
-- Adds support for the "dormant" thread lifecycle state and indexes the
-- (status, last_updated_at) tuple to make future story-continuity queries
-- (e.g. tying old dormant threads to fresh active ones) cheap.
--
-- Lifecycle:
--   active   → cooling  after 14 days of no new articles
--   cooling  → dormant  after another 14 days (28 days total)
--   dormant  → (kept forever, date-indexed for cross-era continuity)

-- If a CHECK constraint exists restricting `status`, drop it so 'dormant' is allowed.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'story_threads'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE story_threads DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

-- Index for efficient lifecycle sweeps + future continuity lookups
CREATE INDEX IF NOT EXISTS idx_story_threads_status_last_updated
  ON story_threads (status, last_updated_at DESC);

-- Optional: index just on dormant for chronological browsing
CREATE INDEX IF NOT EXISTS idx_story_threads_dormant_date
  ON story_threads (last_updated_at DESC)
  WHERE status = 'dormant';
