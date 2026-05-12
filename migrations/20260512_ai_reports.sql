-- ai_reports — user-submitted reports on AI-generated content.
--
-- Purpose: Apple's App Store review (2024-2025) requires a user-facing
-- report path for AI-generated content surfaced by the app. This table
-- captures those reports so a human can review and act (refine prompts,
-- update moderation, contact user if needed).
--
-- Sources tracked:
--   • 'briefing'           — AI-narrated daily briefing transcripts
--   • 'keyword_explainer'  — /api/keywords/explain inline cards (kwi)
--   • 'heatmap_ask'        — /api/heatmap/ask Q&A responses
--
-- The endpoint accepts both authenticated and anonymous reports
-- (anon users hear free briefings); user_id is NULL when anonymous.
-- Content is capped at 4 KB and note at 1 KB to bound storage.

CREATE TABLE IF NOT EXISTS ai_reports (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID,                                   -- nullable for anonymous reports
    source      TEXT NOT NULL,                          -- 'briefing' | 'keyword_explainer' | 'heatmap_ask'
    context_id  TEXT,                                   -- episode_id | keyword | question / mode pair
    content     TEXT,                                   -- the reported AI output (truncated client-side to 4 KB)
    reason      TEXT,                                   -- 'inaccurate' | 'harmful' | 'misleading' | 'other'
    note        TEXT,                                   -- optional free-form user note (max ~1 KB)
    user_agent  TEXT,                                   -- client UA string (truncated)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the operator query "show me reports newest-first."
CREATE INDEX IF NOT EXISTS idx_ai_reports_created_at
  ON ai_reports (created_at DESC);

-- Index for per-source triage ("show me every briefing report").
CREATE INDEX IF NOT EXISTS idx_ai_reports_source_created
  ON ai_reports (source, created_at DESC);
