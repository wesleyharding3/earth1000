# Earth00 v2 — Wireframe 3D Scenes

Companion to `GOOGLE_3D_TILES_ANALYSIS.md`. The original analysis assumed a
**photoreal** integration (Google's photogrammetric mesh + satellite imagery) for
a "deep zoom on a real place" feature. v2 pivots to **minimalist gold wireframe**
visualizations as the primary visual layer for briefings, threads, and timelines —
of-a-piece with the existing brand (italic gold "e", wireframe globe in the
welcome overlay, gold-on-black UI).

The two paths are not in conflict: keep the original doc as the roadmap for an
optional "see this place for real" feature; this doc is the canonical plan for
the wireframe visuals that will drive every briefing/thread/timeline scene.

---

## 1. Why Photoreal Google 3D Tiles Are the Wrong Source

The original doc planned to load Google's photoreal mesh and overlay event
markers. For the new vision, that data source is wrong. Photogrammetric mesh
is **triangle soup** — each building's facade is rebuilt as thousands of small
textured triangles. Strip the texture and render as wireframe and you get:

- Terrain that looks like crumpled aluminum foil
- Buildings that look like spiky stalagmites
- Trees that become triangle clouds
- Edges everywhere, none of them meaningful

Wireframe needs **vector polygons** (footprints, contour lines, line strings) —
data that already separates "what's a building" from "what's a tree" so that
extruding and outlining produces clean prismatic geometry. Google's photoreal
tiles intentionally erase that separation in favor of a unified mesh.

**Bottom line:** photoreal for "see the real place" is fine. Photoreal as a
source for wireframe is a category mismatch.

---

## 2. Right Data Stack

| Layer | Source | Render |
|---|---|---|
| **Building footprints + heights** | Mapbox Streets v8 (`building` source layer with `height` extrusion attribute), OSM `building=*` as fallback | Extrude polygon to prism → `THREE.EdgesGeometry` → glowing thin gold line shader |
| **Terrain** | Mapbox Terrain DEM-v1 (raster-rgb height tiles) | Regular grid mesh → wireframe material with low-frequency contour emphasis |
| **Coastlines / rivers / roads** | Mapbox Streets line-string features (`waterway`, `road_*`, `boundary`) | Plain glowing polylines, varying intensity by feature class |
| **Country boundaries (high zoom out)** | Already in repo: `custom.geo.json` / `ne_50m_land.geojson` | Existing globe rendering — reused for thread/timeline pull-out shots |

### Why Mapbox over OSM-only

- Building heights are pre-aggregated and de-noised (OSM has wildly inconsistent
  `height` tagging — sometimes meters, sometimes floors, sometimes missing)
- Terrain DEM is global, consistent resolution, no separate hosting
- Vector tile pricing ($1 / 1k loads, 50k/month free) is realistic at our scale
- We already have a brand-consistent tile renderer pattern (the existing
  `custom.geo.json` overlay is conceptually identical)

### Why not Cesium ion / Maptiler

- Cesium ion: more powerful but heavier API surface; lock-in worse than Mapbox
- Maptiler: viable alternative, almost feature-equivalent. Pick Mapbox because
  the JS ecosystem (vector tile parsers, examples) is bigger.

### Fallback chain

1. Mapbox tile request — primary
2. Cached vector tile in our backend (90-day TTL) — covers re-renders cheaply
3. OSM Overpass query for buildings — last resort for areas Mapbox misses

---

## 3. Scene Composition Per Surface

Every "scene" is a render of a wireframe 3D environment with a camera path,
optional event markers, and optional voiceover sync.

### 3.1 Briefings — pre-rendered MP4 alongside voiceover

The current briefing pipeline (`briefingGenerator.js`) produces a 12-segment
audio episode. v2 adds a parallel video track:

```
For each segment:
  ↓
  Resolve location (lat/lon, optional radius from segment metadata)
  ↓
  Build wireframe scene around that location (buildings + terrain + roads)
  ↓
  Camera path: high pull-back at segment start, slow zoom to mid-frame focus,
              gentle drift during voiceover, pull-back at segment end
  ↓
  Render at 30fps to MP4 segment
  ↓
  Concatenate segments → final episode video matching audio length
```

- Output: **single H.264 MP4 at 1080×1920 (9:16) for mobile** — matches the
  current briefing UI's portrait orientation
- Storage: object storage (Supabase Storage / S3), NOT bytea in Postgres —
  videos are ~10-20MB each and would bloat the DB
- Playback: HTML5 `<video>` synced to the existing audio element
- Why pre-render not real-time: deterministic quality, zero per-listen cost,
  zero mobile GPU load (every existing briefing user can play it), and the
  briefing is non-interactive by design — no reason to render live

### 3.2 Threads — interactive in-browser scene

A thread spans multiple events across geography and time. Scene = wireframe
globe → camera arc to first event location → arc to next → arc to next → wide
pull-out showing the full geographic spread. Reuses the welcome-overlay
aesthetic (the user already saw this style; landing the same look here =
brand cohesion).

- Output: live Three.js render in a panel that replaces the current "thread
  panel" hero area (or augments it)
- Camera: scripted arc through event locations, paced by article significance
- Interaction: user can drag to rotate, scrub through arc playhead, tap an
  event marker to read that article
- Why real-time not pre-render: thread state is dynamic (articles get added,
  importance scores change), interactivity is the value-add

### 3.3 Lines (timelines) — same as threads, time-paced

Identical render pipeline to threads, but the camera dwells longer at events
that span more days, accelerates through tightly-clustered moments. The scene
is a *temporal* arc rather than a spatial one — the camera literally flies
through history.

### 3.4 Globe overview (page-level, replaces 3D photo globe)

Optional: replace the current photoreal-textured Three.js globe with a
wireframe variant on globe-page-load. Cheaper, more brand-consistent, and
reuses the welcome overlay's wireframe pattern. Skip for v2 if scope grows;
the existing globe is fine in parallel.

---

## 4. Render Pipeline

### 4.1 Server pre-render (briefings)

```
[ briefingGenerator.js writes segments table ]
              ↓
   wireframeRenderCron.js polls for unrendered episodes
              ↓
   Spawn headless Chrome (Puppeteer) → renderer page
              ↓
   For each segment, page builds Three.js scene, captures frames via CDP
              ↓
   Pipe frames to ffmpeg → MP4 segment
              ↓
   Concatenate segments → upload to Supabase Storage / S3
              ↓
   Update briefing_episodes.video_url + status
```

**Tooling**:

- `puppeteer` — drives headless Chrome (already widely deployed)
- `puppeteer-stream` or CDP `Page.startScreencast` — frame capture
- `fluent-ffmpeg` — frame → MP4 piping
- Three.js renderer page hosted at `/internal/wireframe-renderer.html`,
  takes scene params via query string

**Cost shape**: each segment is ~8 seconds × 30fps = 240 frames; render time
~1-2 minutes per segment on a small Render worker. A 12-segment episode takes
~15-25 minutes total. Run as a cron, not request-time.

### 4.2 Browser real-time (threads / lines)

```
User opens a thread
      ↓
Frontend fetches event list + locations
      ↓
WireframeSceneClient (Three.js):
  - Pre-warms Mapbox vector tiles for all event locations (2-3 zoom levels)
  - Builds geometry (buildings + terrain + roads) per scene
  - Sets up camera arc + animation timeline
  - Wires marker click handlers
      ↓
Renders at 60fps (30fps on lower-end mobile)
```

**Bundle impact**: an additional ~40-60KB gzipped for the scene client + Mapbox
vector tile parser. Loaded lazily — only when the user opens a thread for the
first time.

### 4.3 Hybrid recommendation

Pre-render briefings, real-time render threads + lines. Best fit for each:

- Briefings are non-interactive and watched-not-explored → pre-render wins
- Threads / lines benefit from rotation, scrubbing, marker-tap → real-time wins

This split also splits cost: pre-render compute is one-time per episode (cheap),
browser render cost scales with active users (acceptable at our tier sizes).

---

## 5. Brand Aesthetic Spec

Match the welcome overlay's wireframe vocabulary so all wireframe surfaces feel
like one product:

| Property | Value | Source |
|---|---|---|
| Primary stroke | `rgba(255, 200, 80, 0.55)` | `.ewGlobeOutline` |
| Secondary stroke | `rgba(255, 195, 80, 0.32)` | `.ewGlobeLine` |
| Faint stroke | `rgba(255, 195, 80, 0.18)` | `.ewGlobeLineFaint` |
| Stroke width | 0.5–0.9px @ 1× DPR; scale × DPR for retina | welcome wireframe |
| Glow filter | `feGaussianBlur stdDeviation 0.9–1.4` | welcome wireframe |
| Background | Solid black with subtle radial gradient | `#earthWelcome` |
| Ambient motion | 32s rock + 9s breathe (loops) | welcome wireframe |
| Camera moves | Cinematic — slow zooms, eased curves, no shake | new spec |
| Highlight color (events) | `rgba(255, 255, 255, 0.85)` for active marker; same gold for ambient | new spec |

Three layer-stroke tiers (primary / secondary / faint) is enough to convey
hierarchy without going polychromatic. Resist any temptation to color-code
event types — wireframe + monochrome is the differentiator. Use *intensity* and
*size* for hierarchy instead.

---

## 6. Backend Additions

### 6.1 Scene metadata table

```sql
CREATE TABLE wireframe_scenes (
  id              SERIAL PRIMARY KEY,
  scene_type      TEXT NOT NULL,           -- 'briefing_segment' | 'thread' | 'timeline'
  reference_id    INTEGER NOT NULL,        -- briefing_episode.id, thread.id, etc.
  segment_index   INTEGER,                 -- briefings only
  bbox            GEOMETRY(POLYGON, 4326), -- viewport extent
  cameras         JSONB,                   -- [{ at_ms, lat, lon, alt, look_at, ... }]
  markers         JSONB,                   -- event markers with positions
  video_url       TEXT,                    -- briefings: S3/Supabase URL
  rendered_at     TIMESTAMPTZ,
  status          TEXT NOT NULL,           -- 'pending' | 'rendering' | 'ready' | 'failed'
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scene_type, reference_id, segment_index)
);
CREATE INDEX idx_wireframe_scenes_status ON wireframe_scenes (status, created_at);
```

### 6.2 New cron: `wireframeRenderCron.js`

Mirror of `briefingGenerator.js` but for video. Polls `wireframe_scenes WHERE
status = 'pending'`, renders, uploads, marks ready. Uses Render's existing cron
infrastructure (no new platform).

### 6.3 New endpoint: `GET /api/wireframe/scene/:scene_type/:reference_id`

Returns `{ video_url, cameras, markers, duration_ms }` for clients. Pre-render
pipelines fill in `video_url`; live-render pipelines (threads/lines) leave it
null and clients use the camera + marker spec to drive Three.js.

### 6.4 Scene synthesizer module: `wireframeSceneBuilder.js`

For each surface type, produces the camera path and marker list from the
underlying entity. Pure function, no rendering — outputs the spec the renderer
consumes. Keeps render-pipeline-specific code (Puppeteer / Three.js) separate
from scene composition logic, so we can swap renderers later without rewriting
the camera math.

### 6.5 Mapbox tile proxy

Per the original doc's security rule: never embed the Mapbox key in the
frontend. Add `GET /api/tiles/mapbox/*` proxy to `server.js` that injects the
key server-side and rate-limits per user (50 req/min). Cache tile responses
for 90 days locally so repeat scenes don't re-fetch.

---

## 7. Frontend Additions

### 7.1 `WireframeScenePlayer` component

Drop-in panel that takes a scene spec + optional video URL:

- If `video_url` present → render `<video>` element synced to audio
- If `cameras + markers` present → mount Three.js renderer, run animation
- Fallback: existing static globe / hero image

Lazy-loaded so the bundle stays small for users who never open a thread.

### 7.2 Integration points

- **Briefing UI** — replace the static hero image with the scene player; sync
  to existing `<audio>` via `audio.currentTime` driving `video.currentTime`
- **Thread panel** — replace or augment the hero with a real-time scene
- **Timeline panel** — same as thread
- **Globe overview** (optional) — wireframe globe replaces or coexists with
  the photoreal globe

### 7.3 Audio sync (briefings)

Use the existing `<audio>` as the source-of-truth clock. Subscribe to its
`timeupdate` events and call `video.currentTime = audio.currentTime` whenever
they drift more than 200ms. Both elements are HTML5 — no extra libs needed.

---

## 8. Performance, Cost, and Scale

### 8.1 Mapbox tile costs (browser real-time path)

| Surface | Tiles per scene | Scenes per active user / month | Tile loads / month / user |
|---|---|---|---|
| Thread interactive scene | ~20 (3-4 locations × 4-6 tiles) | ~10 | ~200 |
| Timeline interactive scene | ~20 | ~5 | ~100 |
| Total per active user | | | **~300 / month** |

Assume 1k active users × 300 tiles = 300k loads / month. After 50k free, 250k
billable × $1/1k = **$250/month** at v2 launch scale. Cacheable locally per
user → effective cost ~$50-100/month with cache hit rates we can realistically
achieve (~70%).

### 8.2 Pre-render compute cost (briefings)

Briefings generated daily (1 system-wide per day per the audit). 12 segments ×
~1.5 minutes per segment = ~18 minutes render time per episode. On a small
Render worker (~$7/month base), 30 episodes / month × 18 min = 9 hours / month
= well within capacity.

### 8.3 Storage cost (briefings)

15MB per episode × 30 episodes / month = 450MB / month new. On Supabase
Storage at $0.021/GB/month = **~$1/month**. Cumulative growth slow.

### 8.4 Total estimated v2 incremental cost at launch

- Mapbox: $50-100 / month
- Render compute: bundled with existing
- Storage: $1-5 / month

**~$55-105 / month additional infra**, scaling with active users.

### 8.5 Mobile performance

- iOS Capacitor: pre-rendered MP4 is ideal — hardware decoder, near-zero CPU
- Real-time threads/lines: target 30fps on iPhone 12 (current support floor),
  60fps on iPhone 14+. Profiling required to confirm vector-tile parse cost
- Memory budget: 80-120MB for an active scene (typical for our tile counts)

---

## 9. Phased Rollout

### Phase 1 — Foundation (1-2 weeks)
- Build the wireframe Three.js renderer module (`WireframeRenderer`)
- Mapbox tile proxy in `server.js` + per-user rate limit
- Test with 3 reference cities (NYC, London, Tokyo) — vector quality varies
- Match welcome-overlay aesthetic exactly (use the existing CSS variables
  where possible)

### Phase 2 — Briefing pre-render pipeline (1 week)
- `wireframe_scenes` table + migration
- `wireframeSceneBuilder.js` for briefing segments — extracts location from
  segment metadata, builds camera path
- Puppeteer-driven render harness on Render
- ffmpeg pipeline → MP4 → Supabase Storage upload
- `wireframeRenderCron.js` cron entry in `package.json`
- New endpoint `/api/wireframe/scene/...`

### Phase 3 — Briefing UI integration (3-5 days)
- `WireframeScenePlayer` component
- Sync to existing audio element via `timeupdate`
- Fallback to static hero image if scene not yet rendered

### Phase 4 — Thread interactive scenes (1-2 weeks)
- Real-time render path in `WireframeScenePlayer`
- Camera arc engine (animate position + lookAt along Bezier curves)
- Marker tap → opens article (reuse existing `openArticleDetail`)
- Drag-to-rotate, scrub-bar interaction

### Phase 5 — Timeline scenes (3-5 days)
- Same render path as threads, time-paced camera
- Importance-weighted dwell duration

### Phase 6 — Polish + perf (1 week)
- Mobile profiling, frame-budget enforcement
- Reduced-motion accessibility
- Audio-sync drift correction
- Tile cache warming for top-N most-viewed locations

**Total: 6-9 weeks** from start to threads + timelines + briefing scenes shipping.

---

## 10. Open Questions

1. **Mapbox account / API key** — do you have one provisioned, or do we need to
   set this up first? Affects Phase 1 timeline.
2. **Briefing video aspect ratio** — confirm 9:16 (1080×1920) for mobile-first?
   Or 16:9 for desktop parity?
3. **Per-user render quota** — should pre-rendered briefings be available to all
   tiers or only Pro+? (`tierLimits.js` is now credit-based; we could add a
   `briefing_video` cost or keep it free since it's pre-rendered once and
   served to everyone.)
4. **Scene source-of-truth for camera paths** — generated server-side from
   article geo-metadata, or curated by editors? (Editorial control gives better
   visual results; automation scales better.)
5. **Audio narration for thread/timeline scenes** — eventually generate per-thread
   voiceover too, or keep them silent + text-only?
6. **Globe page wireframe replacement** — do this in v2, or defer? (Adds scope
   but completes the brand transition.)

---

## 11. Risks and Fallbacks

| Risk | Mitigation |
|---|---|
| Mapbox vector data sparse in some regions | Fall back to OSM Overpass; if both fail, render terrain-only with a "data sparse" overlay |
| Server-side Puppeteer fragile in production | Run in a dedicated worker with restart policy; queue + retry failed renders 3× before alerting |
| Mobile 60fps unachievable with N buildings | Auto-degrade: cull buildings further, drop to 30fps, switch to pre-rendered fallback for that scene |
| Mapbox cost spikes if a story goes viral | Per-user rate limit + per-tile cache; alert at 80% of monthly budget |
| Pre-rendered video storage growth unbounded | Lifecycle policy: delete videos for episodes >180 days old (briefing has historical archive in DB still); regenerate on demand |
| Browser bundle bloat from new render code | Lazy-load entire `WireframeScenePlayer` module on first use; keep core SPA size unchanged |

---

## 12. Files / Code Layout (Anticipated)

```
/server.js                              + GET /api/wireframe/scene/...
                                        + GET /api/tiles/mapbox/*
/wireframeSceneBuilder.js               (new) scene spec composer
/wireframeRenderCron.js                 (new) Puppeteer + ffmpeg render queue
/migrations/20260601_wireframe_scenes.sql  (new) schema
/internal/wireframe-renderer.html       (new) Puppeteer target page
/www/js/WireframeRenderer.js            (new) shared Three.js renderer
/www/js/WireframeScenePlayer.js         (new) frontend player component
/www/js/MapboxVectorTileFetch.js        (new) tile fetch + parse + cache
/index.html (and www/index.html)        + integration points (briefing, thread,
                                          timeline panels)
```

Mirror everything between `index.html` (root) and `www/index.html` per the
existing pattern, until the audit's "single SPA file" cleanup happens. (At
which point this becomes one of the cleaner extraction candidates — these
new modules are well-bounded.)

---

## 13. What Stays From the Original Doc

The original `GOOGLE_3D_TILES_ANALYSIS.md` remains valid for one specific
future feature: a **"see this place for real"** deep-zoom that complements the
wireframe scenes. Imagine a long-press on a wireframe building → cuts to the
photoreal Google Tiles version of the same view → photo-realistic backdrop for
~5 seconds → cuts back. That's a separate, smaller follow-on project, not part
of v2.

For v2, photoreal is firmly out. Wireframe is the visual identity.
