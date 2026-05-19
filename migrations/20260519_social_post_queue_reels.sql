-- 20260519_social_post_queue_reels.sql
--
-- Adds Reel support to social_post_queue. The PICK phase alternates
-- carousel ↔ reel across cron firings; each row's post_kind dictates
-- which rendering pipeline and which IG API flow get used.
--
--   post_kind  TEXT  'carousel' (default) | 'reel'
--   reel_mp4   BYTEA  stitched 9:16 MP4 produced by the new reel
--                     renderer (portrait + arc + pie + articles
--                     concatenated end-to-end).
--
-- Existing rows backfill to 'carousel' so the new column never has
-- NULLs that the PICK/PUBLISH code has to special-case.

ALTER TABLE social_post_queue
  ADD COLUMN IF NOT EXISTS post_kind text NOT NULL DEFAULT 'carousel';

ALTER TABLE social_post_queue
  ADD COLUMN IF NOT EXISTS reel_mp4 bytea;

-- Enum-like guard so a typo can't sneak in 'reels' / 'CAROUSEL' / etc.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'social_post_queue_post_kind_check'
  ) THEN
    ALTER TABLE social_post_queue
      ADD CONSTRAINT social_post_queue_post_kind_check
      CHECK (post_kind IN ('carousel', 'reel'));
  END IF;
END $$;

-- Index used by the PICK alternation lookup ("what was the last
-- post_kind we actually posted?"). Composite to keep MAX(posted_at)
-- per kind fast without a full table scan.
CREATE INDEX IF NOT EXISTS social_post_queue_kind_posted_at_idx
  ON social_post_queue (post_kind, posted_at DESC)
  WHERE status = 'posted';
