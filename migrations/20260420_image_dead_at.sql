-- ═══════════════════════════════════════════════════════════════════════════
--  Dead-URL flags for hero images on threads + lines
--
--  Context: publishers rotate article image URLs aggressively. A hero URL
--  that was live at ingestion time may return 404 days later, and the
--  <img> onerror chain on the client can leave a Safari "?" glyph before
--  falling through. A daily cron (heroImageValidator.js) HEAD-checks every
--  image currently eligible to serve as a hero on an active or cooling
--  thread/line, and marks dead URLs here. The hero SQL in server.js then
--  filters WHERE image_dead_at IS NULL / dead_at IS NULL, so the existing
--  DISTINCT ON ordering naturally surfaces the next-most-recent alive
--  image as the new hero.
--
--  Revival: if a URL comes back 2xx+image/* after being marked dead, the
--  validator clears the timestamp. No history beyond "currently dead or not."
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS image_dead_at TIMESTAMPTZ;
ALTER TABLE image_assets  ADD COLUMN IF NOT EXISTS dead_at       TIMESTAMPTZ;

-- Partial indexes for the "alive" filter used by every hero SQL. Keeps
-- the dominant case (image_dead_at IS NULL) cheap. A full index on every
-- row would be wasteful since the dead set is expected to stay small
-- (< 5% of hero-eligible rows).
CREATE INDEX IF NOT EXISTS idx_news_articles_alive_hero
  ON news_articles (id)
  WHERE image_dead_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_image_assets_alive
  ON image_assets (id)
  WHERE dead_at IS NULL;
