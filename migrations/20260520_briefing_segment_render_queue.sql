-- 20260520_briefing_segment_render_queue.sql
--
-- Per-segment render-job queue driving the Mac worker's briefing-clip
-- pipeline (content-production output: a standalone 9:16 MP4 of every
-- briefing segment, dropped into the user's local project folder so it
-- can be re-posted to TikTok / Reels / Shorts).
--
-- Lifecycle:
--   pending   ← inserted by briefingGenerator when an episode reaches
--                status='ready' (one row per non-empty segment)
--   claimed   ← worker GET /api/video-jobs/briefings/pending hands it
--                out and atomically flips the status (lease window
--                tracked via claimed_at)
--   completed ← worker POST /api/video-jobs/briefings/.../complete after
--                it muxes audio+video and writes the MP4 to disk
--   failed    ← worker POST .../skip (puppeteer crash, ffmpeg error,
--                segment-end signal never arrived, etc.)
--
-- A lease-reclaim job can re-enqueue rows stuck in 'claimed' state past
-- ~30 min by flipping them back to 'pending' — but the cron firing
-- pattern here is sparse (one new episode per day, ~10 segments) so
-- we don't bother with it in v1. Re-running the migration is safe.

CREATE TABLE IF NOT EXISTS briefing_segment_render_queue (
  id           SERIAL PRIMARY KEY,
  episode_id   integer NOT NULL REFERENCES briefing_episodes(id) ON DELETE CASCADE,
  segment_idx  integer NOT NULL,
  status       text    NOT NULL DEFAULT 'pending',
  claimed_at   timestamptz,
  completed_at timestamptz,
  error_text   text,
  bytes_out    integer,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (episode_id, segment_idx)
);

CREATE INDEX IF NOT EXISTS idx_bsrq_status_id
  ON briefing_segment_render_queue (status, id);
