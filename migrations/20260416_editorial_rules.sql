-- ═══════════════════════════════════════════════════════════════════════════
-- editorial_rules — learned editorial preferences, distilled from
-- editor_events by editorialRuleMiner.js. Layer 3 of the preference stack.
--
-- A rule represents a repeated editorial pattern like "demote sports
-- threads below importance 5" or "merge threads sharing country + leader
-- name within 48h". Layer 4 reads these rules and prepends them to the
-- prompts sent to Claude when building threads/timelines.
--
-- Design notes:
--   * `rule_key` is stable — a deterministic hash over (entity_type,
--     pattern.field, pattern.scope_value, pattern.direction) — so
--     re-mining upserts instead of duplicating.
--   * `confidence` is the fraction of matching events that followed this
--     pattern (e.g. 17/20 = 0.85).
--   * `pattern` JSONB is the machine-readable form; `rule_text` is the
--     natural-language form written by Haiku for prompt injection.
--   * `enabled` + `override_text` let an admin disable a bad rule or
--     hand-edit wording without re-mining.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS editorial_rules (
  id              SERIAL PRIMARY KEY,
  rule_key        TEXT         UNIQUE NOT NULL,
  entity_type     TEXT         NOT NULL,                    -- 'thread' | 'timeline' | 'both'
  scope           TEXT,                                      -- optional: category / keyword / geographic_scope the rule applies to
  rule_text       TEXT         NOT NULL,                    -- Claude-ready natural language
  pattern         JSONB        NOT NULL,                    -- {field, direction, value, scope_field, scope_value, ...}
  confidence      REAL         NOT NULL DEFAULT 0,          -- 0..1 — fraction of matching events that match the pattern
  sample_count    INT          NOT NULL DEFAULT 0,          -- supporting event count
  last_seen_at    TIMESTAMPTZ,                              -- most recent supporting event
  first_mined_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_mined_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,       -- admin toggle
  override_text   TEXT,                                      -- admin-supplied wording that wins over rule_text
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_editorial_rules_enabled
  ON editorial_rules (entity_type, enabled, confidence DESC)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_editorial_rules_scope
  ON editorial_rules (entity_type, scope)
  WHERE scope IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editorial_rules_last_mined
  ON editorial_rules (last_mined_at DESC);
