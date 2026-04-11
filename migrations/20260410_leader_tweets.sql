-- Leader tweets table for storing tweets from world leaders
-- Polled via Twitter/X API Basic tier

CREATE TABLE IF NOT EXISTS leader_tweets (
  id                SERIAL PRIMARY KEY,
  tweet_id          TEXT NOT NULL UNIQUE,
  twitter_handle    TEXT NOT NULL,
  leader_name       TEXT NOT NULL,
  leader_title      TEXT,
  country           TEXT,
  iso_code          TEXT,
  tweet_text        TEXT NOT NULL,
  tweet_created_at  TIMESTAMPTZ NOT NULL,
  retweet_count     INTEGER DEFAULT 0,
  like_count        INTEGER DEFAULT 0,
  reply_count       INTEGER DEFAULT 0,
  media_urls        JSONB DEFAULT '[]'::jsonb,
  is_retweet        BOOLEAN DEFAULT FALSE,
  is_reply          BOOLEAN DEFAULT FALSE,
  fetched_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leader_tweets_handle ON leader_tweets(twitter_handle);
CREATE INDEX IF NOT EXISTS idx_leader_tweets_created ON leader_tweets(tweet_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leader_tweets_iso ON leader_tweets(iso_code);
CREATE INDEX IF NOT EXISTS idx_leader_tweets_fetched ON leader_tweets(fetched_at DESC);
