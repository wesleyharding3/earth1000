-- ─── Add missing ISO 3166-1 alpha-2 country rows ──────────────────────────
--
-- The /api/heatmap/ask endpoint passes a whitelist of countries to Claude
-- and silently drops any ISO codes not in the whitelist. Diagnostic runs
-- (heatmap-test.js) showed Claude correctly returning ISO codes the
-- production countries table didn't recognize, e.g.:
--   • CZ Czech Republic   — dropped on every "EU members" query
--   • PS Palestine        — dropped on Muslim-majority query
--   • GL Greenland        — listed but as lowercase "gl", same effect
--   • CI Côte d'Ivoire    — dropped on coastline queries
-- Plus a handful of jurisdictions that are commonly referenced in news
-- (Hong Kong, Macao, Vatican City, Kosovo, Western Sahara, Sint Maarten).
--
-- Idempotent: runs UPDATEs against existing rows and INSERTs missing ones.
-- Safe to re-run.

-- ── Step 1: fix existing rows whose iso_code is wrong-cased or NULL ─────
-- Greenland exists with lowercase 'gl' which fails the case-sensitive
-- whitelist check in server.js. Force uppercase.
UPDATE countries SET iso_code = UPPER(iso_code)
  WHERE iso_code IS NOT NULL AND iso_code != UPPER(iso_code);

-- Palestine and Kosovo exist as rows with NULL iso_code; backfill them.
UPDATE countries SET iso_code = 'PS' WHERE name = 'Palestine' AND iso_code IS NULL;
UPDATE countries SET iso_code = 'XK' WHERE name = 'Kosovo'    AND iso_code IS NULL;
UPDATE countries SET iso_code = 'GL' WHERE name = 'Greenland' AND iso_code IS NULL;

-- ── Step 2: insert sovereign/territorial entries that were entirely absent ──
INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Czech Republic', 'czech-republic', 49.8175, 15.4730, 'CZ', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'CZ');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Côte d''Ivoire', 'cote-divoire', 7.5400, -5.5471, 'CI', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'CI');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Vatican City', 'vatican-city', 41.9029, 12.4534, 'VA', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'VA');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Hong Kong', 'hong-kong', 22.3193, 114.1694, 'HK', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'HK');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Macao', 'macao', 22.1987, 113.5439, 'MO', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'MO');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Western Sahara', 'western-sahara', 24.2155, -12.8858, 'EH', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'EH');

INSERT INTO countries (name, slug, latitude, longitude, iso_code, is_active)
SELECT 'Sint Maarten', 'sint-maarten', 18.0708, -63.0501, 'SX', true
WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'SX');
