-- Expand keyword_intelligence_cache mode CHECK to allow sources-stats
-- Required by sourcesStatsCron.js

ALTER TABLE keyword_intelligence_cache
  DROP CONSTRAINT keyword_intelligence_cache_mode_check;

ALTER TABLE keyword_intelligence_cache
  ADD CONSTRAINT keyword_intelligence_cache_mode_check
  CHECK (mode IN ('trending', 'rising', 'sources-stats'));
