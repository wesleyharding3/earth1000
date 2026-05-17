-- Add 'pending_video' status to social_post_queue.
--
-- The Mac-as-video-worker pipeline introduces an intermediate state
-- between picking a thread and publishing it: the queue row sits in
-- 'pending_video' until a local headless Puppeteer (running on the
-- admin's Mac when they're working) generates the arc-flyby MP4 and
-- uploads it to /tmp/arc-cache/{thread_id}.mp4.
--
-- Render's picker cron has no GPU → can't generate WebGL videos
-- reliably. So we defer video gen to the only GPU we have access to
-- (the admin's Mac), and gate publishing on its completion.
--
-- Status lifecycle:
--   pending_video      ← picker cron sets this when video is required
--   pending_approval   ← (legacy) video came in OR manual flow chose this
--   approved           ← video uploaded OR threshold-exceeded stale fallback
--   posted | skipped | failed

ALTER TABLE public.social_post_queue
  DROP CONSTRAINT IF EXISTS social_post_queue_status_check;

ALTER TABLE public.social_post_queue
  ADD CONSTRAINT social_post_queue_status_check
  CHECK (status IN ('pending_video','pending_approval','approved','posted','skipped','failed'));

-- Index on (status, scheduled_for) for the publisher cron's scan of
-- approved rows + the worker poll's scan of pending_video rows.
-- Existing idx_social_post_queue_status_scheduled covers this but
-- we recreate to make sure the new status values are picked up by
-- the planner stats. (Postgres updates planner stats lazily.)
ANALYZE public.social_post_queue;
