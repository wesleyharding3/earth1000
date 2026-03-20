CREATE TABLE IF NOT EXISTS image_assets (
  id               SERIAL PRIMARY KEY,
  public_url       TEXT NOT NULL UNIQUE,
  object_path      TEXT NOT NULL UNIQUE,
  folder_path      TEXT,
  file_name        TEXT,
  primary_category TEXT,
  generic_category TEXT,
  keywords         TEXT[] NOT NULL DEFAULT '{}',
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  city_id          INTEGER REFERENCES cities(id) ON DELETE SET NULL,
  country_id       INTEGER REFERENCES countries(id) ON DELETE SET NULL,
  priority         DOUBLE PRECISION NOT NULL DEFAULT 1,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS image_asset_tags (
  image_id    INTEGER NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  weight      DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (image_id, tag_id)
);

CREATE TABLE IF NOT EXISTS image_category_fallbacks (
  category          TEXT NOT NULL,
  fallback_category TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, fallback_category)
);

CREATE TABLE IF NOT EXISTS article_image_assignments (
  article_id        INTEGER PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
  image_id          INTEGER REFERENCES image_assets(id) ON DELETE SET NULL,
  source_type       VARCHAR(32) NOT NULL DEFAULT 'fallback',
  match_strategy    TEXT,
  matched_tag_id    INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  matched_keyword   TEXT,
  matched_category  TEXT,
  confidence        DOUBLE PRECISION NOT NULL DEFAULT 0,
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS image_usage_log (
  id           BIGSERIAL PRIMARY KEY,
  article_id   INTEGER REFERENCES news_articles(id) ON DELETE CASCADE,
  image_id     INTEGER REFERENCES image_assets(id) ON DELETE SET NULL,
  surface      VARCHAR(32) NOT NULL DEFAULT 'feed',
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_assets_active_city
  ON image_assets (city_id, is_active, priority DESC, usage_count ASC);

CREATE INDEX IF NOT EXISTS idx_image_assets_active_country
  ON image_assets (country_id, is_active, priority DESC, usage_count ASC);

CREATE INDEX IF NOT EXISTS idx_image_assets_primary_category
  ON image_assets (primary_category, is_active);

CREATE INDEX IF NOT EXISTS idx_image_assets_generic_category
  ON image_assets (generic_category, is_active);

CREATE INDEX IF NOT EXISTS idx_image_assets_keywords_gin
  ON image_assets USING GIN (keywords);

CREATE INDEX IF NOT EXISTS idx_image_asset_tags_tag
  ON image_asset_tags (tag_id, image_id);

CREATE INDEX IF NOT EXISTS idx_article_image_assignments_image
  ON article_image_assignments (image_id);

CREATE INDEX IF NOT EXISTS idx_image_usage_log_article_used_at
  ON image_usage_log (article_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_usage_log_image_used_at
  ON image_usage_log (image_id, used_at DESC);
