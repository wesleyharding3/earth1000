-- ─────────────────────────────────────────────────────────────────────
-- Adds story_threads.last_split_check_at — set after every successful
-- pass of splitOversizedThreads.js. Gates that script so a thread that
-- already passed split-evaluation isn't re-evaluated on every cron tick
-- until new articles arrive.
--
-- NULL = never checked (eligible). Existing rows start NULL.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS last_split_check_at TIMESTAMPTZ;

-- Partial index restricted to oversized threads. The gate query is
-- "article_count >= THRESHOLD AND (last_split_check_at IS NULL OR
-- last_updated_at > last_split_check_at)". Threshold is currently 200
-- but the index doesn't bake it in — Postgres uses the index for any
-- article_count-based filter that exceeds the threshold.
CREATE INDEX IF NOT EXISTS idx_story_threads_split_gate
  ON story_threads (article_count DESC, last_split_check_at, last_updated_at)
  WHERE status IN ('active','cooling');
