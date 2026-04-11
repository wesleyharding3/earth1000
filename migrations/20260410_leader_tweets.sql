-- Leader tweets table — admin-curated tweets displayed via oEmbed
-- Admins paste tweet URLs, server fetches oEmbed HTML for display

CREATE TABLE IF NOT EXISTS leader_tweets (
  id                SERIAL PRIMARY KEY,
  tweet_id          TEXT NOT NULL UNIQUE,
  tweet_url         TEXT NOT NULL,
  twitter_handle    TEXT NOT NULL,
  leader_name       TEXT,
  leader_title      TEXT,
  country           TEXT,
  iso_code          TEXT,
  tweet_text        TEXT,
  oembed_html       TEXT,
  oembed_author     TEXT,
  pinned            BOOLEAN DEFAULT FALSE,
  added_by          UUID,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leader_tweets_handle ON leader_tweets(twitter_handle);
CREATE INDEX IF NOT EXISTS idx_leader_tweets_created ON leader_tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leader_tweets_iso ON leader_tweets(iso_code);
