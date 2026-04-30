-- ─────────────────────────────────────────────────────────────────────
-- Tombstone table for article-from-thread ejections.
--
-- Without this table, an article ejected from a thread (via the audit
-- script's --detach pass OR via storyThreadBuilder's in-prompt EJECT
-- action) goes straight back into the unthreaded pool, and on the next
-- 30-min builder cycle it can re-cluster into the SAME thread it was
-- just removed from — turning the audit into a treadmill that pays
-- Haiku to re-do the same work every cron tick.
--
-- The fix: every ejection writes a (thread_id, article_id) row here.
-- storyThreadBuilder filters its INSERT-into-story_thread_articles by
-- this table, dropping any pair that has a tombstone. Permanent by
-- default — no expiry. Different threads can still attach the article;
-- only the specific (thread, article) pair is forbidden.
--
-- Schema notes:
--   • PK on (thread_id, article_id) gives us the O(log N) lookup the
--     builder needs at attachment time, AND prevents duplicate
--     tombstones if the audit re-runs on the same article. ON CONFLICT
--     DO NOTHING in the writer makes the insert idempotent.
--   • Secondary index on article_id alone in case we ever want to
--     answer "which threads has this article been ejected from?"
--     (useful for debugging false-positive ejections).
--   • source column tracks who wrote the row — keeps audit / in-prompt
--     eject / manual cleanup distinguishable when reviewing later.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS story_thread_article_ejections (
  thread_id   INT          NOT NULL,
  article_id  INT          NOT NULL,
  ejected_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason      TEXT,
  source      TEXT         NOT NULL,
  PRIMARY KEY (thread_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_ejections_article
  ON story_thread_article_ejections (article_id);
