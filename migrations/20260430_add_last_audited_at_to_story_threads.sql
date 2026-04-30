-- ─────────────────────────────────────────────────────────────────────
-- Adds story_threads.last_audited_at — set after every successful pass
-- of auditThreadArticles.js. Used to gate that script so it skips
-- threads that haven't accumulated new articles since their last audit.
--
-- Without this gate the script re-audits every active+cooling thread
-- on every cron tick, which at twice-daily cadence + ~300 threads runs
-- ~$2.70/day. With the gate it only re-audits threads where
-- last_updated_at > last_audited_at — typical hit rate ~25%, dropping
-- the bill to ~$0.70/day.
--
-- NULL = never audited yet (eligible for first pass). Existing rows
-- start NULL by default, so the FIRST run after deploy will still see
-- every thread — the savings kick in from the second run onward.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS last_audited_at TIMESTAMPTZ;

-- Partial index for the gate's eligibility check. Postgres will use it
-- when answering "give me threads where last_updated_at > last_audited_at
-- OR last_audited_at IS NULL". Conditional on (status IN ...) so the
-- index footprint stays small — dormant threads aren't audited and
-- don't need to be in the lookup.
CREATE INDEX IF NOT EXISTS idx_story_threads_audit_gate
  ON story_threads (last_audited_at, last_updated_at)
  WHERE status IN ('active','cooling');
