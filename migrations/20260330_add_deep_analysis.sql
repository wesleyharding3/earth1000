-- Track which articles received deep NLP analysis
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS deep_analyzed_at TIMESTAMPTZ;

-- Store extracted named entities per article
CREATE TABLE IF NOT EXISTS article_entities (
  id          SERIAL PRIMARY KEY,
  article_id  INTEGER      NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  entity_text TEXT         NOT NULL,
  entity_type TEXT         NOT NULL CHECK (entity_type IN ('person','organization','location','event')),
  relevance   FLOAT        NOT NULL DEFAULT 0.5,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_entities_article_id
  ON article_entities (article_id);

CREATE INDEX IF NOT EXISTS idx_article_entities_type_text
  ON article_entities (entity_type, entity_text);

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_entities_dedup
  ON article_entities (article_id, entity_text, entity_type);
