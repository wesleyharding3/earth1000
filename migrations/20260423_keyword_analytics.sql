-- keyword_analytics — precomputed per-keyword rollups used by the
-- Keyword Intelligence widget's inline "✦" context expansion. Populated
-- twice daily by keywordAnalyticsCron.js so the /api/keywords/explain
-- endpoint can deliver the structured context panel without running
-- expensive aggregates on every user click.
--
-- Columns:
--   keyword              canonical keyword string (lowercased + normalized)
--   display_keyword      best-cased form for UI (first non-empty surface form)
--   total_mentions       distinct-article count across the whole history
--   recent_mentions      distinct-article count in the last 7 days
--   country_breakdown    [{ iso, name, n, pct }, ...] top 8 + "+N more"
--                        where pct is the share of recent_mentions
--   sample_article_ids   curated id list (max 10) used to seed the Claude
--                        prompt on /api/keywords/explain — newest first,
--                        tie-broken by base_priority DESC
--   refreshed_at         last cron run that touched this row
CREATE TABLE IF NOT EXISTS keyword_analytics (
  keyword              text PRIMARY KEY,
  display_keyword      text,
  total_mentions       int  NOT NULL DEFAULT 0,
  recent_mentions      int  NOT NULL DEFAULT 0,
  country_breakdown    jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_article_ids   int[] NOT NULL DEFAULT ARRAY[]::int[],
  refreshed_at         timestamptz NOT NULL DEFAULT NOW()
);

-- Lookups by recency for the cron's own sweep + for monitoring.
CREATE INDEX IF NOT EXISTS idx_keyword_analytics_refreshed_at
  ON keyword_analytics (refreshed_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyword_analytics_recent_mentions
  ON keyword_analytics (recent_mentions DESC);
