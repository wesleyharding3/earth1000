-- Bulk starter tags for imported images.
-- Safe to rerun: inserts use ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Category fallback rules for the resolver
-- ---------------------------------------------------------------------------
INSERT INTO image_category_fallbacks (category, fallback_category, priority)
VALUES
  ('finance', 'economy', 1),
  ('economy', 'trade', 2),
  ('trade', 'industry', 1),
  ('trade', 'economy', 2),
  ('military', 'security', 1),
  ('security', 'military', 2),
  ('government', 'law', 1),
  ('law', 'government', 2),
  ('religion', 'culture', 1),
  ('landscape', 'environment', 1),
  ('environment', 'general', 2),
  ('general', 'general', 99)
ON CONFLICT (category, fallback_category) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Folder-level seed tags
-- ---------------------------------------------------------------------------
WITH folder_tag_map AS (
  SELECT 'commons_imgs'::text AS folder_path, 'general'::text AS tag_name UNION ALL
  SELECT 'imgs',                'general' UNION ALL
  SELECT 'misc_imgs',           'general' UNION ALL
  SELECT 'landscape_imgs',      'general' UNION ALL
  SELECT 'landscape_imgs',      'environment' UNION ALL
  SELECT 'finance_imgs',        'finance' UNION ALL
  SELECT 'finance_imgs',        'economy' UNION ALL
  SELECT 'foreigngov_imgs',     'government' UNION ALL
  SELECT 'foreigngov_imgs',     'law' UNION ALL
  SELECT 'mil_imgs',            'military' UNION ALL
  SELECT 'mil_imgs',            'security' UNION ALL
  SELECT 'religion_imgs',       'religion' UNION ALL
  SELECT 'religion_imgs',       'culture' UNION ALL
  SELECT 'trade_imgs',          'trade' UNION ALL
  SELECT 'trade_imgs',          'economy' UNION ALL
  SELECT 'trade_imgs',          'industry'
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, 1.0
FROM image_assets ia
JOIN folder_tag_map ftm ON ftm.folder_path = ia.folder_path
JOIN tags t ON LOWER(t.name) = ftm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Trade refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'trade_imgs/agriculture%'::text AS path_pattern, 'agriculture'::text AS tag_name, 1.2::double precision AS weight UNION ALL
  SELECT 'trade_imgs/%grain%',            'agriculture',   1.15 UNION ALL
  SELECT 'trade_imgs/%farm%',             'agriculture',   1.15 UNION ALL
  SELECT 'trade_imgs/%harvest%',          'agriculture',   1.15 UNION ALL
  SELECT 'trade_imgs/%tea%',              'agriculture',   1.10 UNION ALL
  SELECT 'trade_imgs/%air_cargo%',        'infrastructure',1.15 UNION ALL
  SELECT 'trade_imgs/%air_freight%',      'infrastructure',1.15 UNION ALL
  SELECT 'trade_imgs/%cargo%',            'infrastructure',1.10 UNION ALL
  SELECT 'trade_imgs/%port%',             'infrastructure',1.10 UNION ALL
  SELECT 'trade_imgs/%container%',        'infrastructure',1.10 UNION ALL
  SELECT 'trade_imgs/%shipping%',         'infrastructure',1.10 UNION ALL
  SELECT 'trade_imgs/%freight%',          'infrastructure',1.10 UNION ALL
  SELECT 'trade_imgs/%factory%',          'industry',      1.10 UNION ALL
  SELECT 'trade_imgs/%industrial%',       'industry',      1.10 UNION ALL
  SELECT 'trade_imgs/%silo%',             'industry',      1.05 UNION ALL
  SELECT 'trade_imgs/%energy%',           'energy',        1.05
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Finance refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'finance_imgs/%bank%'::text AS path_pattern,     'finance'::text AS tag_name, 1.2::double precision AS weight UNION ALL
  SELECT 'finance_imgs/%budget%',                        'finance',       1.15 UNION ALL
  SELECT 'finance_imgs/%cash%',                          'finance',       1.10 UNION ALL
  SELECT 'finance_imgs/%vault%',                         'finance',       1.10 UNION ALL
  SELECT 'finance_imgs/%calculator%',                    'finance',       1.05 UNION ALL
  SELECT 'finance_imgs/%business%',                      'economy',       1.10 UNION ALL
  SELECT 'finance_imgs/%district%',                      'economy',       1.05 UNION ALL
  SELECT 'finance_imgs/%cargo%',                         'trade',         1.05 UNION ALL
  SELECT 'finance_imgs/%port%',                          'trade',         1.05 UNION ALL
  SELECT 'finance_imgs/%construction%',                  'infrastructure',1.05
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Government refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'foreigngov_imgs/%parliament%'::text AS path_pattern, 'government'::text AS tag_name, 1.25::double precision AS weight UNION ALL
  SELECT 'foreigngov_imgs/%capitol%',                          'government',      1.20 UNION ALL
  SELECT 'foreigngov_imgs/%congress%',                         'government',      1.20 UNION ALL
  SELECT 'foreigngov_imgs/%senate%',                           'government',      1.20 UNION ALL
  SELECT 'foreigngov_imgs/%knesset%',                          'government',      1.20 UNION ALL
  SELECT 'foreigngov_imgs/%palace%',                           'government',      1.10 UNION ALL
  SELECT 'foreigngov_imgs/%embassy%',                          'government',      1.10 UNION ALL
  SELECT 'foreigngov_imgs/%ministry%',                         'government',      1.10 UNION ALL
  SELECT 'foreigngov_imgs/%court%',                            'law',             1.20 UNION ALL
  SELECT 'foreigngov_imgs/%justice%',                          'law',             1.20 UNION ALL
  SELECT 'commons_imgs/%white_house%',                         'government',      1.15 UNION ALL
  SELECT 'commons_imgs/%supreme_court%',                       'law',             1.15 UNION ALL
  SELECT 'commons_imgs/%world_bank%',                          'economy',         1.10 UNION ALL
  SELECT 'commons_imgs/%united_nations%',                      'government',      1.10
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Military refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'mil_imgs/%carrier%'::text AS path_pattern, 'military'::text AS tag_name, 1.20::double precision AS weight UNION ALL
  SELECT 'mil_imgs/%carrier%',                       'security',       1.10 UNION ALL
  SELECT 'mil_imgs/%radar%',                         'security',       1.20 UNION ALL
  SELECT 'mil_imgs/%defense%',                       'security',       1.15 UNION ALL
  SELECT 'mil_imgs/%missile%',                       'military',       1.20 UNION ALL
  SELECT 'mil_imgs/%tank%',                          'military',       1.20 UNION ALL
  SELECT 'mil_imgs/%fighter%',                       'military',       1.20 UNION ALL
  SELECT 'mil_imgs/%warship%',                       'military',       1.20 UNION ALL
  SELECT 'mil_imgs/%drone%',                         'technology',     1.05 UNION ALL
  SELECT 'mil_imgs/%satellite%',                     'technology',     1.05
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Religion refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'religion_imgs/%bible%'::text AS path_pattern,    'religion'::text AS tag_name, 1.20::double precision AS weight UNION ALL
  SELECT 'religion_imgs/%church%',                         'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%mosque%',                         'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%temple%',                         'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%buddha%',                         'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%cathedral%',                      'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%synagogue%',                      'religion',       1.20 UNION ALL
  SELECT 'religion_imgs/%statue%',                         'culture',        1.05 UNION ALL
  SELECT 'religion_imgs/%study%',                          'education',      1.05
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Landscape refinements
-- ---------------------------------------------------------------------------
WITH pattern_tag_map AS (
  SELECT 'landscape_imgs/%forest%'::text AS path_pattern,  'environment'::text AS tag_name, 1.10::double precision AS weight UNION ALL
  SELECT 'landscape_imgs/%mountain%',                      'environment',      1.10 UNION ALL
  SELECT 'landscape_imgs/%river%',                         'environment',      1.10 UNION ALL
  SELECT 'landscape_imgs/%desert%',                        'environment',      1.10 UNION ALL
  SELECT 'landscape_imgs/%glacier%',                       'environment',      1.10 UNION ALL
  SELECT 'landscape_imgs/%coast%',                         'environment',      1.10
)
INSERT INTO image_asset_tags (image_id, tag_id, weight)
SELECT ia.id, t.id, ptm.weight
FROM image_assets ia
JOIN pattern_tag_map ptm ON ia.object_path ILIKE ptm.path_pattern
JOIN tags t ON LOWER(t.name) = ptm.tag_name
ON CONFLICT (image_id, tag_id) DO NOTHING;
