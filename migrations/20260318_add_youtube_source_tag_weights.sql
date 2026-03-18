CREATE TABLE IF NOT EXISTS youtube_source_tag_weights (
  youtube_source_id integer NOT NULL REFERENCES youtube_sources(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  weight double precision NOT NULL,
  PRIMARY KEY (youtube_source_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_source_tag_weights_source_id
  ON youtube_source_tag_weights (youtube_source_id);
