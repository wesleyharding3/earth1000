-- Add 'timeline' as a valid scope_type for data_panels
-- This enables the timeline editor to save data panels per timeline

ALTER TABLE data_panels DROP CONSTRAINT IF EXISTS data_panels_scope_type_check;
ALTER TABLE data_panels ADD CONSTRAINT data_panels_scope_type_check
  CHECK (scope_type IN ('briefing_segment', 'thread', 'timeline'));

-- Index for timeline panel lookups
CREATE INDEX IF NOT EXISTS data_panels_timeline_idx
  ON data_panels (scope_type, scope_id, ord)
  WHERE scope_type = 'timeline';
