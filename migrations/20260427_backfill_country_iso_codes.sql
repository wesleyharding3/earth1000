-- ─── Backfill ISO codes for countries with NULL iso_code ────────────────
--
-- The /api/heatmap/ask endpoint passes a whitelist of countries to Claude
-- with `WHERE iso_code IS NOT NULL AND length(iso_code) = 2`. Six rows
-- in production currently have iso_code NULL, so Claude never sees them
-- in the catalog and can't include them in any answer:
--   • Cabo Verde
--   • Czechia                              (duplicate of "Czech Republic" CZ)
--   • Democratic Republic of the Congo     ← user-facing complaint: CD missing
--   • Federated States of Micronesia
--   • Ivory Coast                          (duplicate of "Côte d'Ivoire" CI)
--   • Republic of the Congo
--
-- Idempotent: each UPDATE skips when an existing row already holds the ISO,
-- so re-running won't create duplicate-iso conflicts. Safe to re-run.

-- ── Canonical sovereign rows currently NULL ─────────────────────────────
UPDATE countries SET iso_code = 'CV'
  WHERE name = 'Cabo Verde' AND iso_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'CV');

UPDATE countries SET iso_code = 'CD'
  WHERE name = 'Democratic Republic of the Congo' AND iso_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'CD');

UPDATE countries SET iso_code = 'FM'
  WHERE name = 'Federated States of Micronesia' AND iso_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'FM');

UPDATE countries SET iso_code = 'CG'
  WHERE name = 'Republic of the Congo' AND iso_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM countries WHERE iso_code = 'CG');

-- ── Rows where the canonical-named row already exists with the ISO ──────
-- "Czechia" and "Ivory Coast" are colloquial duplicates — the prior migration
-- 20260425_add_missing_iso_countries.sql inserted "Czech Republic" (CZ) and
-- "Côte d'Ivoire" (CI). The colloquial dups must NOT take CZ / CI (would
-- conflict). Set them to NULL-but-inactive so they stop appearing in lookups
-- without violating any unique constraint on iso_code.
UPDATE countries SET is_active = false
  WHERE name IN ('Czechia', 'Ivory Coast')
  AND   iso_code IS NULL
  AND   is_active IS DISTINCT FROM false;

-- ── Sanity check (logs counts; does not modify) ─────────────────────────
DO $$
DECLARE
  null_count int;
  total_count int;
BEGIN
  SELECT COUNT(*) INTO null_count FROM countries
    WHERE iso_code IS NULL OR length(iso_code) != 2;
  SELECT COUNT(*) INTO total_count FROM countries;
  RAISE NOTICE '[20260427] countries total=% missing-iso=%', total_count, null_count;
END$$;
