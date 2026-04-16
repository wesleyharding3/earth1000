-- ═══════════════════════════════════════════════════════════════════════════
-- editor_events — append-only log of every editor mutation on threads and
-- timelines. This is the raw training data for the preference miner
-- (Layer 3). Every admin mutation wraps its DB write with a call to
-- logEditorEvent() which appends a row here.
--
-- Design notes:
--   * Append-only. We never UPDATE or DELETE these rows.
--   * `before_state` and `after_state` are opaque JSONB snapshots of the
--     mutated entity (thread or timeline). `diff` is the pre-computed
--     per-field delta {field: [old, new]} — the miner reads this first
--     and falls back to before/after when it needs more context.
--   * `context` carries operation-specific extras the snapshots don't
--     capture (merge source IDs, moved article IDs on a split,
--     article-remove article_id, etc.).
--   * editor_id is the Supabase auth user that performed the mutation.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS editor_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT        NOT NULL,       -- 'thread.update', 'thread.merge', 'thread.split', 'thread.delete', 'thread.remove_article', 'timeline.update', ...
  entity_type   TEXT        NOT NULL,       -- 'thread' | 'timeline'
  entity_id     INT,                        -- primary affected entity (NULL for delete-after-log cases where we only have context)
  editor_id     UUID,                       -- Supabase auth user id; NULL if unknown
  before_state  JSONB,                      -- snapshot pre-mutation
  after_state   JSONB,                      -- snapshot post-mutation (NULL for deletes)
  diff          JSONB,                      -- {field: [old, new]} shallow delta
  context       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_editor_events_entity
  ON editor_events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_editor_events_type
  ON editor_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_editor_events_editor
  ON editor_events (editor_id, created_at DESC)
  WHERE editor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editor_events_created
  ON editor_events (created_at DESC);

-- GIN index on diff so the miner can quickly find "all events that touched
-- keywords" / "all events that changed importance" without a table scan.
CREATE INDEX IF NOT EXISTS idx_editor_events_diff_gin
  ON editor_events USING GIN (diff jsonb_path_ops);
