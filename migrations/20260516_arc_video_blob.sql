-- Store the rendered arc.mp4 binary IN the queue row.
--
-- We can't rely on the web service's /tmp/arc-cache directory because:
--   (a) Render web services are multi-instance with load-balanced traffic.
--       An MP4 written to instance A's /tmp is invisible to instance B's
--       /tmp — the GET that fetches the video lands on a random instance
--       and 404s for any instance other than the writer.
--   (b) /tmp gets reset on every container restart (deploys, scale events,
--       OOM kills, etc.) so even single-instance setups lose the file.
--
-- BYTEA in social_post_queue is the simplest shared storage we already
-- have. MP4s for our case run 200KB–3MB; a typical week of queued rows
-- is < 50MB. Postgres handles this cleanly.
--
-- The /share/thread/:id/arc.mp4 route reads here; the Mac-worker upload
-- writes here. /tmp is still used as a hot-path cache on the serving
-- instance, but the DB is now the source of truth.

ALTER TABLE public.social_post_queue
  ADD COLUMN IF NOT EXISTS arc_video BYTEA;
