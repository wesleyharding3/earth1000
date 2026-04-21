-- ═══════════════════════════════════════════════════════════════════════════
--  Regions — add polygon geometry for the "middle-ground" story layer
--
--  The regions table has 164 existing rows with centroid_lat/lng (point).
--  That representation renders as nodes on the globe, which reads as
--  cartoonish. This adds a full polygon boundary to each region so the
--  globe can paint actual shapes for "Maghreb", "Polynesia", "Andes", etc.
--
--  Geometry column is nullable — existing rows stay valid until their
--  polygons are drawn in the editor. MultiPolygon so non-contiguous
--  regions (archipelagos, island chains) fit the same schema as simple
--  land blobs.
--
--  snap_to_coast is a per-region flag for the editor:
--    TRUE  → coastal regions like Chile, Maghreb (default) — snap vertices
--            to the land/water boundary so the polygon hugs the shore.
--    FALSE → oceanic / archipelago regions like British Isles, Polynesia,
--            Maritime SE Asia — the ocean IS part of the region, snapping
--            to coast would fragment it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE regions
  ADD COLUMN IF NOT EXISTS geom            GEOMETRY(MultiPolygon, 4326),
  ADD COLUMN IF NOT EXISTS snap_to_coast   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS geom_updated_at TIMESTAMPTZ;

-- GiST index on geom so the near-bbox / point-in-polygon queries stay fast
-- once the data is populated.
CREATE INDEX IF NOT EXISTS idx_regions_geom ON regions USING GIST (geom);
