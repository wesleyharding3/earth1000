-- ═══════════════════════════════════════════════════════════════════════════
--  Manual (curator-created) Lines
--
--  Story lines normally graduate from threads: a thread accumulates 3+
--  sources over 24h, then >= 2 attached threads ever elevates it to a
--  Line. That pipeline misses steady-state stories that never have a
--  newsy "spike" big enough to create threads — Tigray recovery, Cuba
--  energy crisis, Bukele's crackdown, Moroccan protests. Yet we still
--  want those Lines to exist and collect coverage.
--
--  `is_manual = TRUE` marks a row as curator-created:
--    • Never subject to the multi-thread quality gate (immune to sweeps)
--    • Still scanned by the article umbrella phase on every builder run
--    • Backfill endpoint can pull historical articles over a wider window
--  `created_by` stores the admin that created it (for audit / dashboards).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE story_timelines
  ADD COLUMN IF NOT EXISTS is_manual  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Partial index so the quality-gate exemption query stays cheap: only
-- index the manual rows (tiny slice of the table).
CREATE INDEX IF NOT EXISTS idx_story_timelines_manual
  ON story_timelines (id)
  WHERE is_manual = TRUE;
