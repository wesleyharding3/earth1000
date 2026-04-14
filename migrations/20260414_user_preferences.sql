-- User preferences table for onboarding questionnaire and feed personalization.
-- Stored in Supabase (not Render Postgres) alongside auth/profile data.
-- Run this in the Supabase SQL Editor if the admin endpoint cannot create it.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  home_country  TEXT,                          -- ISO code of home country
  interest_regions JSONB NOT NULL DEFAULT '[]', -- [{type:"country"|"city", id:number, name:string, iso?:string}]
  interest_topics  JSONB NOT NULL DEFAULT '[]', -- ["climate","conflict","economy",...]
  interest_sectors JSONB NOT NULL DEFAULT '[]', -- ["technology","finance","energy",...]
  languages        JSONB NOT NULL DEFAULT '[]', -- ["en","fr","ar",...]
  diversity_pref   INTEGER NOT NULL DEFAULT 50, -- 0=echo chamber, 100=max diversity
  depth_pref       TEXT NOT NULL DEFAULT 'both', -- 'brief' | 'deep' | 'both'
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Users can read and write only their own preferences
CREATE POLICY "Users can view own preferences"
  ON user_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own preferences"
  ON user_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own preferences"
  ON user_preferences FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role (backend) bypasses RLS automatically
