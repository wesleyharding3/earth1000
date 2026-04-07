-- Data analytics panels for briefings and threads
-- Each panel is one chart attached to either:
--   • a briefing segment  (scope_type='briefing_segment', scope_id=episode_id, segment_index=N)
--   • a story thread      (scope_type='thread',           scope_id=thread_id,  segment_index=NULL)

CREATE TABLE IF NOT EXISTS data_panels (
  id              SERIAL PRIMARY KEY,
  scope_type      TEXT        NOT NULL CHECK (scope_type IN ('briefing_segment', 'thread')),
  scope_id        INTEGER     NOT NULL,
  segment_index   INTEGER,
  ord             INTEGER     NOT NULL DEFAULT 0,           -- display order within scope
  title           TEXT        NOT NULL,
  subtitle        TEXT,
  caption         TEXT,
  chart_type      TEXT        NOT NULL CHECK (chart_type IN
                    ('line','bar','stacked_bar','area','pie','scatter')),
  data            JSONB       NOT NULL,                     -- { labels, series:[{name,values,color?}], unit, x_label, y_label }
  source_name     TEXT,                                     -- e.g. 'World Bank', 'EIA', 'Our World in Data'
  source_url      TEXT,                                     -- direct link to the API call / dataset
  generated_by    TEXT        NOT NULL DEFAULT 'ai_real'    -- 'ai_real' (claude+adapter), 'ai_composed' (claude-only fallback), 'manual'
                    CHECK (generated_by IN ('ai_real','ai_composed','manual')),
  adapter         TEXT,                                     -- which dataSources adapter produced this (NULL for composed/manual)
  query           JSONB,                                    -- adapter query params, for audit/regen
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS data_panels_briefing_idx
  ON data_panels (scope_type, scope_id, segment_index, ord)
  WHERE scope_type = 'briefing_segment';

CREATE INDEX IF NOT EXISTS data_panels_thread_idx
  ON data_panels (scope_type, scope_id, ord)
  WHERE scope_type = 'thread';

-- Cleanup helper: when a briefing episode is regenerated, drop its old panels.
CREATE OR REPLACE FUNCTION delete_panels_for_episode(p_episode_id INTEGER)
RETURNS VOID AS $$
  DELETE FROM data_panels
  WHERE scope_type = 'briefing_segment' AND scope_id = p_episode_id;
$$ LANGUAGE SQL;
