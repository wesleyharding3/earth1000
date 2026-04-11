-- Seed country_feed_boost with preferred countries
-- ! countries (extra boost) get 1.8, regular boost countries get 1.4
-- Default (no row) = 1.0

-- Create table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS country_feed_boost (
  country_id INTEGER PRIMARY KEY REFERENCES countries(id),
  boost_score NUMERIC(4,2) NOT NULL DEFAULT 1.0
);

-- Clear existing data and reseed
TRUNCATE country_feed_boost;

-- Extra boost countries (! prefix in spec)
INSERT INTO country_feed_boost (country_id, boost_score)
SELECT id, 1.8 FROM countries WHERE LOWER(name) IN (
  'russia', 'israel', 'iran', 'united states', 'lebanon'
)
ON CONFLICT (country_id) DO UPDATE SET boost_score = EXCLUDED.boost_score;

-- Standard boost countries
INSERT INTO country_feed_boost (country_id, boost_score)
SELECT id, 1.4 FROM countries WHERE LOWER(name) IN (
  'turkey', 'japan', 'egypt', 'south africa', 'mexico',
  'argentina', 'brazil', 'venezuela', 'colombia', 'canada',
  'australia', 'thailand', 'indonesia', 'india', 'pakistan',
  'china', 'germany', 'france', 'united kingdom', 'spain',
  'hungary', 'italy', 'poland', 'greece', 'saudi arabia'
)
ON CONFLICT (country_id) DO UPDATE SET boost_score = EXCLUDED.boost_score;
