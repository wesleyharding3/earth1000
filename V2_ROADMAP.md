# Earth00 v2 — Roadmap

V1 is shipping. Everything in this document is **post-launch** work — features
we explored, scoped, and explicitly tabled in conversation so V1 could land on
time. None of these are starting until V1 is in users' hands.

Companion documents:

- **`WIREFRAME_3D_V2.md`** — full spec for the wireframe-3D scene system that
  becomes the visual identity for briefings/threads/lines in v2. Track 2 below
  is the integration manifest; the spec itself lives there.
- **`GOOGLE_3D_TILES_ANALYSIS.md`** — the photoreal "see-this-place-for-real"
  follow-on, kept around as a smaller post-v2 feature.
- **`CLUSTER_ARCHITECTURE_PLAN.md`** — independent of this roadmap; refactor
  track for the SPA file structure.

---

## How v2 is organized

Four tracks. Each track has multiple features. Each feature is sized + scoped
enough to spawn its own implementation doc when it gets built.

| Track | Theme | Why it matters |
|---|---|---|
| **1** | Briefing media expansion | Featured-media variety beyond YouTube + X + heatmap |
| **2** | Wireframe 3D scenes | Visual identity unification — see `WIREFRAME_3D_V2.md` |
| **3** | Social & community layer | Comments, live chat, reactions, forum |
| **4** | AI integration & assistant | Briefing chatbot, contextual Q&A |

There is no fifth "infrastructure" track because most of what this roadmap
needs (heatmap-AI mode pluggability, scene metadata table, audio/video sync)
is already in V1's bones. New tracks add data sources and render paths, not
new platforms.

---

## Track 1 — Briefing media expansion

V1 supports three featured-media types: **heatmap overlay**, **YouTube clip**,
**X/Twitter post**. (The previous `twitter_video` option was removed pre-launch
because Twitter's widget API doesn't expose autoplay; we kept `twitter_post` as
the only static-tweet variant.)

V2 adds new types as **functions of the heatmap-AI** — the same orchestration
that already resolves heatmap questions becomes the central media-takeover
engine. Each new visualization mode below is a tool the heatmap-AI can choose
when picking a focal moment for a segment.

### 1.1 Sankey commodity-trade flows

**What it is**: when a segment topic involves global trade of an essential
commodity (wheat, oil, gold, arms, microchips, …), the heatmap-AI takeover
renders a Sankey diagram of the top-N bilateral flows for that commodity in
the latest available year.

**Free data sources** (verified):

| Commodity | HS code | Primary | Backup |
|---|---|---|---|
| Wheat | 1001 | UN Comtrade | FAOSTAT |
| Corn | 1005 | UN Comtrade | FAOSTAT, USDA FAS |
| Soybeans | 1201 | UN Comtrade | USDA FAS |
| Rice | 1006 | UN Comtrade | FAOSTAT |
| Coffee | 0901 | UN Comtrade | ICO |
| Cotton | 5201 | UN Comtrade | USDA |
| Wool | 5101 | UN Comtrade | FAOSTAT |
| Textiles (chapter) | 50–63 | UN Comtrade | WTO |
| Crude oil | 2709 | UN Comtrade | EIA International |
| Refined petroleum | 2710 | UN Comtrade | EIA |
| Natural gas | 2711 | UN Comtrade | EIA |
| Coal | 2701 | UN Comtrade | EIA |
| Gold | 7108 | UN Comtrade | USGS, World Gold Council |
| Diamonds | 7102 | UN Comtrade | Kimberley Process Statistics |
| Iron ore | 2601 | UN Comtrade | USGS |
| Copper | 7403 | UN Comtrade | USGS |
| Lithium | 2530 | UN Comtrade | USGS |
| Cobalt | 8105 | UN Comtrade | USGS |
| Rare earths | 2805 / 2846 | UN Comtrade | USGS |
| Uranium | 2612 | UN Comtrade | World Nuclear Assn |
| Microchips | 8542 | UN Comtrade | WSTS public reports |
| Arms (major weapons) | (special) | **SIPRI** | UN Comtrade HS 93 (less reliable) |
| Pharmaceuticals | 30 | UN Comtrade | WHO |

UN Comtrade does ~95% of the work: free, ~100 calls/day per IP, 100,000 records
per call, all bilateral flows by HS code. SIPRI handles arms because government
weapons trade is under-reported in Comtrade — SIPRI's Trend-Indicator Value
(TIV) is the journalist standard. SIPRI publishes a free CSV download.

**Schema**:

```sql
CREATE TABLE commodity_flows (
  commodity_id   TEXT NOT NULL,           -- 'wheat' | 'oil_crude' | 'arms' | ...
  year           INT NOT NULL,
  source_iso     TEXT NOT NULL,
  target_iso     TEXT NOT NULL,
  value_usd      BIGINT NOT NULL,
  unit           TEXT,                    -- 'kg' | 'barrels' | 'TIV' (SIPRI)
  unit_value     NUMERIC,
  rank_in_year   INT,                     -- 1 = largest flow that year
  PRIMARY KEY (commodity_id, year, source_iso, target_iso)
);
CREATE INDEX idx_commodity_flows_lookup
  ON commodity_flows (commodity_id, year, rank_in_year);
```

**Heatmap-AI function**:

```
function: commodity_flow
  args:
    commodity: 'wheat' | 'oil_crude' | 'arms' | ...
    year:      INT (default: latest)
    top_n:     INT (default: 20)
    filter:    { country?: ISO, role?: 'source' | 'target' }
  returns:
    sankey: { nodes: [...], links: [...] }
```

**Render**: `d3-sankey` (~30KB) inside a focal-overlay card. Custom dark-theme
styling matching the existing brand. Animated band-thickness on draw.

**Effort**: ~1 week (Comtrade ingest 2d, SIPRI 0.5d, function 1d, render 2d,
generator integration 1d).

**Risks**: Comtrade rate limits if cron throttles wrong; SIPRI license for
commercial vs academic (need to verify our use case fits free terms).

---

### 1.2 Climate overlays — fire / drought / basic climate (time-series)

**What it is**: when a segment topic is climate / disaster, the heatmap-AI
paints a satellite or remote-sensing layer onto the globe and animates it
through the relevant date range. User sees, e.g., the Camp Fire's actual MODIS
thermal-anomaly progression frame-by-frame.

**Free data sources**:

| Layer | Source | Format | History |
|---|---|---|---|
| Active fires | **NASA FIRMS** | GeoJSON points + WMS | 2000–present, daily |
| Burned-area scars | NASA MCD64A1 (via GIBS) | WMTS | 2001–present, monthly |
| Drought (global) | Copernicus Global Drought Observatory | WMS | 2000–present, 10-day |
| Drought (US) | U.S. Drought Monitor | WMS | 2000–present, weekly |
| Sea-surface temp | NOAA OISST (via GIBS) | WMTS | 1981–present, daily |
| Snow cover | NASA MODIS (via GIBS) | WMTS | 2000–present, daily |
| Vegetation health (NDVI) | NASA MODIS (via GIBS) | WMTS | 2000–present, 16-day |
| Air quality (PM2.5) | OpenAQ | JSON points | varies, hourly |

**The unlock is NASA GIBS** (`gibs.earthdata.nasa.gov`) — a free WMTS server
with hundreds of layers. No auth, no rate limits we'd hit. We fetch tiles and
apply them as textures on a sphere mesh slightly larger than the globe (radius
+0.01).

**Heatmap-AI function**:

```
function: climate_overlay
  args:
    layer:       'fires' | 'drought' | 'ndvi' | 'sst' | ...
    region:      { iso?, bbox?, lat_lon? }
    date_range:  { start, end }
    playback:    { fps: 4, loop: true }
  returns:
    tile_template: '...{date}/{z}/{x}/{y}.png'
    frames: [{ date, ... }, ...]
```

**Render**:
- Pre-fetch tiles for all dates in the range (cached at edge)
- Cross-fade through tiles at the configured fps during the focal moment
- Bottom-left date label shows the current frame's date
- Point data (FIRMS fires, OpenAQ air quality) renders as glowing dots, animate
  appearance/disappearance along the timeline

**Linking to stories**: generator detects climate-themed segments via topic
keyword (`fire`, `drought`, `wildfire`, `flood`, `hurricane`, `temperature`,
`bleaching`, …) and picks the relevant layer. Date range defaults to the
segment's time window.

**Effort**:
- First layer (fires) — full pipeline: 4–5d
- Each additional layer: ~1d (framework reused)
- **Fires + drought + 2 GIBS layers: ~1.5 weeks**

**Risks**:
- GIBS tile fetch latency varies (300ms–2s). Need pre-fetch + caching strategy.
- Tile-to-globe alignment: stick to EPSG:4326 layers (most of GIBS's
  offering). Mercator (EPSG:3857) doesn't wrap to a UV-sphere cleanly.

---

### 1.3 Earthquake overlay — pulsing red concentric rings

**What it is**: when a segment is about an earthquake, the heatmap-AI takeover
plays the affected region's seismic event sequence as concentric red rings
pulsing at each epicenter. Reuses the existing ring-pulse architecture.

**Source — USGS Earthquake API**:
- Endpoint: `https://earthquake.usgs.gov/fdsnws/event/1/query`
- Free, no auth, no rate limit we'd hit
- Real-time + historical (1900–present)
- Filter by `starttime`, `endtime`, `minmagnitude`, lat/lon + radius
- Returns GeoJSON with `mag`, `place`, `time`, `depth`, `coordinates`

**Heatmap-AI function**:

```
function: earthquake_overlay
  args:
    region:              { lat, lon, radius_km }
    date_range:          { start, end }
    min_magnitude:       FLOAT (default: 3.5)
    include_aftershocks: BOOL
  returns:
    events: [{ id, lat, lon, magnitude, depth, time }]
```

**Render — extends existing pulse architecture**:
1. New `briefingQuakePulseList` mirroring `briefingArcPulseList` structure
2. Per USGS event: position from lat/lon; color `#ff3322`; initial radius
   `magnitude * 0.5`; final radius `magnitude * 4`; duration 2.5s; ease-out
3. Time-series mode: stagger pulse start times by event timestamp, scaled to
   segment duration
4. Bottom-right magnitude legend (M3 / M5 / M7 reference circles)

**Linking to stories**: keyword detection (`earthquake`, `quake`, `aftershock`,
`seismic`, `tremor`, `richter`); region from segment's primary country/coords.

**Effort**: **~2 days total** — the smallest, most impactful new feature in
this track. Half-day MVP is realistic if pulse scaffolding is in good shape.

**Risks**: minimal. USGS is the most reliable free seismic source on the web.

---

### 1.4 Coverage panel — desktop top-left composite widget

**What it is**: persistent top-left widget on desktop briefings showing
source/country diversity, coverage agreement gauge, and topic cloud as a
single composite component (~280×320px).

**Layout**:

```
┌─────────────────────────────────────────┐
│  EARTH BRIEFING · MAY 9, 2026           │  ← header
├─────────────────────────────────────────┤
│   Source × Country matrix               │  ← 6×6 grid
│   ▣ ▣ ▣ ▢ ▢ ▢                           │
│   ▣ ▣ ▢ ▢ ▢ ▢                           │
│   ...                                    │
├─────────────────────────────────────────┤
│   Coverage agreement                     │
│   ◐━━━━━━━━━━━○   78%                   │
│   12 sources, 8 agree on top story       │
├─────────────────────────────────────────┤
│   #ukraine #opec #fed #climate #china   │  ← topic cloud
│   #migration #ai-regulation              │
└─────────────────────────────────────────┘
```

**Three sub-components**:

1. **Source × Country matrix** — 5–6×5–6 grid of source logos × country flags
   showing coverage breadth at a glance
2. **Coverage agreement gauge** — count of distinct sources that surfaced the
   day's top story / total sources represented (signal-vs-noise indicator)
3. **Topic taxonomy cloud** — auto-extracted keyword importance from all
   segments, scaled by mention frequency; top 8–12 chips

**Data**: aggregated at briefing-open from `episode.segments` joining
`articles`, `news_sources`, and the existing entity extraction.

**Source-logo strategy** (decision deferred):
- (a) Favicon CDN (`google.com/s2/favicons`) — free, fast, sometimes ugly
- (b) **Clearbit Logo API** (`logo.clearbit.com/{domain}`) — free for low
  volume, much cleaner — **recommended**
- (c) Curated SVG library hand-packed in `/assets/source-logos/`

**Mobile**: hidden at `≤720px`. Desktop-only enrichment.

**Effort**: ~2 days (backend aggregation 0.5d, component 1d, logo fetching
+ caching 0.5d).

---

### 1.5 Sentiment heatmap

**What it is**: a new mode in the existing heatmap pipeline. Per-country
polygon paint colored by mean article sentiment about a topic (red = negative,
grey = neutral, green = positive).

**Architecture extension**:

```js
// generator side (existing)
hmMode = 'sentiment'  // new mode
hmQ    = 'Israel-Palestine conflict'
hmResolved = {
  US: 0.32, IL: 0.65, IR: -0.72, ...
}
```

**Sentiment computation**:
- Per-article sentiment scoring at ingest time (cached). Options:
  - **VADER** (free, rule-based) — adequate for English news
  - **RoBERTa cardiffnlp/twitter-roberta-base-sentiment-latest** — better
    accuracy via Hugging Face Inference or self-hosted
  - **Provider LLM (Anthropic / OpenAI)** — best accuracy, $0.001–0.01/article
- New column `articles.sentiment_score FLOAT` (range -1 to +1)

**Color scale**: diverging (red/grey/green) instead of the current sequential.

**Effort**: 1–2 days with VADER; +3–4 days for RoBERTa quality with backfill.

---

### 1.6 Documentary featured-media options

A catalog of seven additional featured-media types under the "real-world media"
umbrella. Each is a separate sub-feature with its own data source. Build any
subset; they share an architecture (a unified `media_assets` table) but each
has its own ingest cron.

| # | Type | Source | Linking |
|---|---|---|---|
| **1.6.1** | Wire-service photo | OpenGraph/`twitter:image` from existing articles (free); paid wire feeds (Reuters/AP/Getty) when budget allows | Already linked — every article has a hero image |
| **1.6.2** | Local-broadcast clip | YouTube channels (BBC News, Al Jazeera Eng, France 24, DW, NHK World, RT, CCTV, TRT, …) | Tag each broadcaster with `country_iso`; prefer domestic outlet for the segment's country |
| **1.6.3** | Press-conference question moment | Gov YouTube channels + C-SPAN | Whisper + `pyannote.audio` diarization → first speaker change after opening = the question |
| **1.6.4** | Government audio statement | Press-release pages (`whitehouse.gov`, `kremlin.ru`, `gov.cn`, Élysée) + extracted from press-conf videos | Speaker ID + transcript matching to article quotes |
| **1.6.5** | Document scan (court filings, FOIA, leaked memos) | **DocumentCloud** (free API, IRE/NICAR — millions OCR'd) + CourtListener (free PACER mirror) | DocumentCloud `q=` API by case name / parties / date |
| **1.6.6** | Wire-copy autoreader (typewriter visual) | Existing article body text — no new source | Already linked — pure rendering treatment |
| **1.6.7** | Court / hearing stream snippet | **Oyez.org** (SCOTUS — free + clean transcript JSON), C-SPAN, UN Web TV | Oyez case API by docket; for non-US, US-only for v1 |

**Common architecture**:

```sql
CREATE TABLE media_assets (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,    -- 'wire_photo' | 'broadcast_clip' | ...
  source_url   TEXT NOT NULL,
  embed_html   TEXT,
  transcript   TEXT,
  country_iso  TEXT,
  date_event   DATE,
  date_pub     DATE,
  entities     TEXT[],
  meta         JSONB
);
```

Generator does a join: "for this segment, find the highest-affinity
`media_asset` by entity overlap + recency + type." This unifies seven bespoke
fetchers into one subsystem.

**Effort by type**:
- 1.6.1 (wire photo from existing articles): 1 day
- 1.6.2 (broadcast YouTube): 3 days (extends existing fetcher)
- 1.6.3 + 1.6.4 (diarization stack): 2 weeks together
- 1.6.5 (DocumentCloud): 1 week
- 1.6.6 (autoreader): 1 day
- 1.6.7 (Oyez): 3 days

---

### 1.7 Tabled briefing-media ideas

Captured here so they're not forgotten:

| # | Idea | Reason tabled | Revisit |
|---|---|---|---|
| 1.7.1 | Camera dive into 3D city via Google Tiles 3D | Heavy lifting + non-trivial billing | post-v2 |
| 1.7.2 | Historic-borders time-rewind | Specialized data + animation pipeline | v3 |
| 1.7.3 | Volumetric phenomena (auroras, ash plumes) at full ray-marching quality | 4–8 weeks for one phenomenon at production grade | v3 |
| 1.7.4 | AI-generated diorama (text-to-3D GLB scenes) | Quality not there yet (2026 state) | revisit in 12 months |
| 1.7.5 | Text-to-video synthesized B-roll (Sora/Veo class) | Quality + legal exposure | revisit in 6–12 months |
| 1.7.6 | Multi-perspective AI character interviews | Differentiating but heavy production; depends on chatbot infra (Track 4) | post-Track-4 |
| 1.7.7 | Generated "letter from the ground" | Tone/safety calibration is hard | post-Track-4 |
| 1.7.8 | Counterfactual narrator mode | Editorial guidelines must precede tech | post-launch + editorial-policy work |

---

## Track 2 — Wireframe 3D scenes

This entire track is specified in **`WIREFRAME_3D_V2.md`**. Read that doc for
the full plan. What lives here is just the v2 integration manifest:

### Track 2 deliverables (per the wireframe doc)

| Phase | Surface | Render mode | Ref |
|---|---|---|---|
| 2.1 | Foundation: `WireframeRenderer` module + Mapbox tile proxy | Library | `WIREFRAME_3D_V2.md` §9 Phase 1 |
| 2.2 | Briefing pre-rendered MP4 (one per episode) | Pre-render | §9 Phase 2 |
| 2.3 | Briefing UI integration with audio sync | Frontend | §9 Phase 3 |
| 2.4 | Thread interactive scenes | Real-time | §9 Phase 4 |
| 2.5 | Timeline interactive scenes | Real-time | §9 Phase 5 |
| 2.6 | Polish + perf | Cross-cutting | §9 Phase 6 |

### Where Track 1 + Track 2 intersect

The wireframe scenes (Track 2) become the **ambient backdrop** for every
briefing. The Track 1 featured-media takeovers play **on top** of that
backdrop during focal moments. The two tracks share the segment timeline as
their orchestration layer:

```
[ Wireframe scene plays continuously beneath the entire briefing ]
                          ↓
       [ At segment N's focal_trigger_ms ]
                          ↓
          [ Track 1 takeover overlay slides in ]
                          ↓
          [ Takeover ends, scene resumes underneath ]
```

This is the same overlay pattern V1 already uses for YouTube and
heatmap takeovers — Track 2 just upgrades what's underneath from a static
hero image to a dynamic wireframe scene.

### Open questions inherited from the wireframe doc

The questions in `WIREFRAME_3D_V2.md` §10 carry forward unchanged:

1. Mapbox account / API key provisioning
2. Briefing video aspect ratio (9:16 mobile-first vs 16:9 desktop-parity)
3. Per-user render quota (free for all tiers, or Pro+ gated?)
4. Camera-path source-of-truth (server-generated vs editor-curated)
5. Per-thread voiceover narration (silent text-only vs synthesized voice?)
6. Globe-page wireframe replacement (in v2 or after?)

---

## Track 3 — Social & community layer

V1 ships as a single-player intelligence product. v2 introduces a community
layer in three increments. Each layer can be shipped independently — they're
ordered from least-disruptive to most-disruptive.

### 3.1 Reactions ("likes") — lightest layer

**What it is**: per-segment, per-article, per-thread, per-line "saved" /
"useful" / "skeptical" reactions. Three discrete reaction types, no free
text. Counts visible to the viewer in aggregate.

**Why three reactions, not one "like"**:
- "Saved" — bookmarking, personal value (replaces V1's bookmark feature)
- "Useful" — communal signal of quality
- "Skeptical" — communal signal of "I have questions about this" without
  pushing into hostile-comment territory

These are intentionally NOT a 5-star rating — that anchors quality on a single
axis. The two communal axes (useful / skeptical) capture the dimensions news
intelligence actually has: signal strength + signal trust.

**Schema**:

```sql
CREATE TABLE reactions (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  target_type   TEXT NOT NULL,    -- 'segment' | 'article' | 'thread' | 'line'
  target_id     INTEGER NOT NULL,
  reaction      TEXT NOT NULL,    -- 'saved' | 'useful' | 'skeptical'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, target_type, target_id, reaction)
);
CREATE INDEX idx_reactions_target ON reactions (target_type, target_id, reaction);
```

**Endpoints**:
- `POST /api/react` — toggle a reaction
- `GET /api/reactions/:type/:id` — counts + whether current user reacted
- `GET /api/me/saved` — user's saved items (replaces V1 bookmark endpoint)

**UI**: three small icon buttons in the bottom-right of every detail panel
and per-segment row in the briefing recap. Animated count pop on toggle.

**Effort**: ~3 days.

**Risks**: low. Pure additive; failures degrade to "reactions unavailable"
without breaking anything.

---

### 3.2 Comments — per-target threaded discussion

**What it is**: text comments on segments, articles, threads, lines.
Threaded one level deep (replies to top-level comments — no nested-nested).

**Schema**:

```sql
CREATE TABLE comments (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  target_type     TEXT NOT NULL,
  target_id       INTEGER NOT NULL,
  parent_id       INTEGER REFERENCES comments(id),
  body            TEXT NOT NULL,
  body_redacted   BOOLEAN DEFAULT FALSE,
  removed         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  edited_at       TIMESTAMPTZ
);
CREATE INDEX idx_comments_target ON comments (target_type, target_id, created_at DESC);
CREATE INDEX idx_comments_parent ON comments (parent_id);
```

**Moderation pipeline**:
- **Tier 1** — automatic: profanity filter (open-source word list) + LLM
  toxicity classifier (single Claude/GPT call per comment, ~$0.001 each)
- **Tier 2** — community: 3 user reports → comment auto-hidden pending review
- **Tier 3** — staff: admin tools to remove + ban
- **Tier 4** — appeals: user-facing "appeal removal" flow for false positives

Pre-launch: **Tier 1 only**. Tier 2–4 unlock as the community grows.

**Why threaded one level**: deeply nested threads are visually unreadable on
mobile and encourage tangents over engagement. One level of reply is the
sweet spot — Hacker News goes deeper, Twitter's "replies" goes deeper, but
neither is good UX. Reddit is unreadable past depth 4. Mastodon top-level
+ one-reply works.

**Permission model**:
- Comments require sign-in (no anonymous)
- Free-tier users can read all, write 5 / day rate-limited
- Pro+ tier: 50 / day
- Editor / staff: unlimited

**Effort**: ~2 weeks (schema + endpoints 3d, frontend 4d, moderation 4d,
rate limiting + abuse prevention 2d, polish 2d).

**Risks**:
- Comments are notoriously high-maintenance. Budget ongoing moderation cost.
- Spam waves are inevitable. Captcha + email-confirmed accounts only at v2.

---

### 3.3 Live chat during briefings — most disruptive, biggest unlock

**What it is**: synchronized real-time chat during briefing playback.
Everyone watching the same date's briefing sees each other's messages
keyed to the segment they're on. Chat persists in the segment's comment
section after the live moment.

**Why it's worth it**: Earth00's "everyone is on the same daily briefing"
loop is the biggest community moment we have. Live chat turns watching the
briefing from a solo into a shared experience — like watching the news with
your group chat. This is structurally different from comments (async) and
reactions (passive).

**Schema** (extends `comments`):

```sql
ALTER TABLE comments ADD COLUMN
  segment_index   INTEGER,     -- which briefing segment they were on
  live_at_ms      INTEGER,     -- ms into segment when posted
  is_live         BOOLEAN DEFAULT FALSE;

-- Indexed lookup: "show me all messages posted within this segment"
CREATE INDEX idx_comments_segment_live ON comments
  (target_type, target_id, segment_index)
  WHERE is_live = TRUE;
```

**Realtime delivery**: Supabase Realtime channels (already in the stack).
Channel per `briefing:{episode_id}`. Posts published to channel + persisted
to `comments`. Subscribers receive push.

**UI**:
- **Desktop**: right-rail chat pane during briefing (~300px wide). Live
  posts fade in at the top. Composer at the bottom. Toggle button to hide.
- **Mobile**: floating bubble at the right edge during briefing — counts
  unread. Tap to expand a 70vh chat sheet. Sheet pauses the briefing
  (consistent with Track 4 chatbot rules).
- **Recap**: posted messages persist to the segment-comments view, so the
  conversation is readable async after the live moment.

**Moderation**: realtime stream means we can't block before publish.
Solution: published messages run through Tier 1 toxicity classifier
async; flagged messages go to a "review" queue and self-hide for 30 min
while pending. False-positive rate matters here — bias toward letting
through and retroactively removing.

**Permission model**:
- Live chat: Pro+ tier only (matches the tone of premium briefing experience)
- Reading live chat: free for everyone
- Writing during recap (after-the-fact comments): free tier rate-limited

**Effort**: ~3 weeks (Supabase Realtime integration 4d, UI desktop 4d,
mobile 4d, moderation pipeline 4d, perf + scale testing 3d).

**Risks**:
- Coordination problem: if no one's chatting, the feature feels dead.
  Mitigation: pre-seed with sparse staff/AI commentary on day-one episodes.
- Trolling at scale: the live-rate model assumes Pro+ filter is enough.
  If not, escalate to "verified human" gating.
- Realtime cost: Supabase Realtime priced per connection. Estimate at
  V2 scale: 1k concurrent during peak briefing minutes = ~$30/month.

---

### 3.4 Forum

**What it is**: long-form Discourse-style forum for topics that exceed a
single article's comment thread. Replaces the "deep dive" use case that
comments aren't built for.

**Why a forum on top of comments**: comments are anchored to specific
items (a segment, an article, a thread). A forum is anchored to *topics* —
themes that span items. "What's actually happening in Sudan?" is a forum
question; "I disagree with this Reuters article on Sudan" is a comment.

**Three top-level categories**:
- **Events** — discussion of current ongoing news events (Ukraine, climate,
  AI regulation, etc.). Created by staff, not users. Auto-linked from
  thread + line pages.
- **Sources** — discussion of news sources themselves. Bias, reliability,
  paywall complaints, source-suggestions.
- **Earth00** — feedback, feature requests, bug reports, meta.

**Schema** (separate from `comments` because the use case is different):

```sql
CREATE TABLE forum_topics (
  id              SERIAL PRIMARY KEY,
  category        TEXT NOT NULL,        -- 'events' | 'sources' | 'earth00'
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_by      UUID NOT NULL,
  thread_id       INTEGER REFERENCES story_threads(id),    -- optional link
  line_id         INTEGER REFERENCES story_timelines(id),  -- optional link
  pinned          BOOLEAN DEFAULT FALSE,
  locked          BOOLEAN DEFAULT FALSE,
  reply_count     INTEGER DEFAULT 0,
  last_reply_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE forum_posts (
  id           SERIAL PRIMARY KEY,
  topic_id     INTEGER NOT NULL REFERENCES forum_topics(id),
  user_id      UUID NOT NULL,
  body         TEXT NOT NULL,
  removed      BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_forum_posts_topic ON forum_posts (topic_id, created_at);
```

**Moderation**: same Tier 1–4 ladder as comments, escalated. Forum threads
are public + crawlable so reputation matters more — bias toward strict.

**Permission model**:
- Read: free
- Reply: free, rate-limited (10/day)
- Create new topic: Pro+ tier
- Auto-lock topics inactive >180 days

**Effort**: ~3 weeks (schema 1d, endpoints 3d, frontend 7d, moderation 4d,
search 3d, polish 3d).

**Risks**:
- Forums need critical mass or they look dead. Start with **only Events**
  and let the other categories unlock with growth.
- SEO blessing-and-curse: forums attract traffic, but bad posts attract bad
  traffic. Robust moderation > none.

---

### 3.5 Open social-layer questions

1. **Identity model** — display names, avatars, bios? Reputation scores?
   Real names required (LinkedIn-like trust) or pseudonymous (Reddit-like
   freedom)?
2. **Notifications** — email digests of replies? In-app push? Settings
   surface?
3. **Friend / follow graph** — should users follow other users? Show their
   recent activity? Or stay activity-anonymous (only counts visible)?
4. **DM / direct message** — explicitly out of scope for v2? Or a small
   feature?
5. **Public profiles** — can a user have a public-facing profile page
   showing their reactions, comments, forum posts? Or kept private by
   default with opt-in?

**Recommended defaults**: pseudonymous, opt-in public profiles, no DM,
no follow graph, email digest only for replies. Minimum viable
identity. Can grow if traction warrants.

---

## Track 4 — AI integration & assistant

V1 has the heatmap-AI for orchestrating media takeovers. v2 introduces
**user-facing AI** in three layers.

### 4.1 Briefing chat assistant — per-segment Q&A

**What it is**: small chat affordance inside the briefing UI. User taps,
asks a question, gets an answer grounded in the active segment's articles.

**UI**:
- **Desktop**: persistent right-rail panel during briefings (~280px wide)
- **Mobile**: small text-field affordance bottom-right; tapping it **pauses
  the briefing** (per V1 conversation), opens an overlay with the question
  + answer

**Why pause on mobile**: limited screen real estate means the chat overlay
covers the briefing. Audio + chat reading at the same time is bad UX.
Pause + read + resume is the cleanest model.

**Backend**: tool-using LLM (Claude/GPT) with these tools:
- `get_segment_articles(segment_index)` — full text of the segment's articles
- `get_episode_summary(episode_id)` — high-level recap
- `search_recent_articles(query, days_back)` — wider search beyond episode
- `get_thread(thread_id)` / `get_line(line_id)` — adjacent context

**Streaming**: SSE (already used by `/api/ai/flow-context`). Heartbeat keeps
mobile WebView from timing out. Response stream replaces the typing dots
character-by-character.

**Cost**: ~$0.003 per question with Claude Sonnet (typical 1.5K input
tokens + 500 output). Free tier: 5 questions/day. Pro+: 50/day.

**Schema**:

```sql
CREATE TABLE ai_chat_sessions (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL,
  context_type TEXT,     -- 'briefing' | 'thread' | 'line' | 'global'
  context_id   INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE ai_chat_turns (
  id           SERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES ai_chat_sessions(id),
  role         TEXT NOT NULL,    -- 'user' | 'assistant'
  body         TEXT NOT NULL,
  tool_calls   JSONB,
  cost_usd     NUMERIC,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Effort**: ~1.5 weeks (backend tool definitions + SSE 4d, frontend 4d,
quota + cost tracking 2d, polish 2d).

---

### 4.2 Thread / line / globe AI assistant — same engine, broader scope

**What it is**: same chat affordance in `WireframeScenePlayer` for thread +
line pages, plus a globe-page-level "ask Earth00" floating button.

**Architecture**: identical to 4.1, just different `context_type` and
different default tool set. Globe-level scope removes segment-specific tools
and adds search across the whole `articles` table.

**Effort**: 3–4 days (mostly UI surface re-skin).

---

### 4.3 Persistent assistant — dock-pinnable Earth00 Assistant

**What it is**: a global AI assistant accessible from any page. Knows the
user's reading history, saved items, current open thread, etc. Operates as
a research partner rather than a Q&A box.

**Capabilities**:
- All tools from 4.1 + 4.2
- `get_my_recent_reads()` / `get_my_saved()` — personalization
- `summarize_my_week()` — weekly digest of stories the user engaged with
- `compare_coverage(topic, sources_a, sources_b)` — cross-source analysis
- `find_dissenting_views(topic)` — surface low-coverage but credible
  contrarian sources

**UI**: bottom-right floating button on all pages → expands to a side
sheet. Persistent across page navigations (URL-resilient state).

**Permission model**: Pro+ only. The global assistant is the premium
differentiator.

**Effort**: ~2 weeks (extends 4.1+4.2 backend; new global UI surface; new
personalization tools).

---

### 4.4 AI safety & guardrails (cross-cutting)

Applies to all of Track 4:

- **Citations required** — every factual claim cites the source article.
  Prompt-enforced; verified by post-generation sanity check ("does the
  cited article actually contain the claim?").
- **Refusals** — specific topics where AI declines: medical/legal advice,
  predictions of geopolitical violence, identifying private individuals
  from photos. Curated refusal list.
- **Bias disclaimers** — when user asks about contested topics, the
  assistant responds with multi-source framing, not a single position.
- **Cost guardrails** — per-user-per-day spending cap. If hit, gentle
  refusal until tomorrow.
- **Audit log** — every prompt + response stored 90 days for moderation
  + abuse review. Disclosed in privacy policy.
- **No personal-data exfiltration** — assistant cannot retrieve other
  users' reading histories, saved items, comments. Verified by tool
  authorization checks.

---

## Catalog: full feature backlog

Sorted by track, with rough effort and priority signals:

| ID | Track | Feature | Effort | Priority |
|---|---|---|---|---|
| 1.1 | Media | Sankey commodity-trade flows | ~1 wk | High |
| 1.2 | Media | Climate overlays (fires + drought first) | ~1.5 wk | High |
| 1.3 | Media | Earthquake overlay | ~2 d | **Highest ROI** |
| 1.4 | Media | Coverage panel (desktop) | ~2 d | Medium |
| 1.5 | Media | Sentiment heatmap | ~2 d | Medium |
| 1.6.1 | Media | Wire-service photos (from existing OG tags) | ~1 d | Medium |
| 1.6.2 | Media | Local-broadcast YouTube clips | ~3 d | High |
| 1.6.3 | Media | Press-conference question detection | ~2 wk | Medium |
| 1.6.4 | Media | Government audio statement | piggyback on 1.6.3 | Medium |
| 1.6.5 | Media | Document scan via DocumentCloud | ~1 wk | High |
| 1.6.6 | Media | Wire-copy autoreader | ~1 d | Low |
| 1.6.7 | Media | Court / hearing snippet (Oyez) | ~3 d | Medium |
| 2.1 | Wireframe | Foundation + Mapbox proxy | ~1–2 wk | High |
| 2.2 | Wireframe | Briefing pre-rendered MP4 | ~1 wk | **High** |
| 2.3 | Wireframe | Briefing UI integration | ~3–5 d | High |
| 2.4 | Wireframe | Thread interactive scenes | ~1–2 wk | Medium |
| 2.5 | Wireframe | Timeline interactive scenes | ~3–5 d | Medium |
| 2.6 | Wireframe | Polish + perf | ~1 wk | High |
| 3.1 | Social | Reactions (saved/useful/skeptical) | ~3 d | **High** |
| 3.2 | Social | Comments | ~2 wk | Medium |
| 3.3 | Social | Live chat during briefings | ~3 wk | High |
| 3.4 | Social | Forum (Events category first) | ~3 wk | Medium |
| 4.1 | AI | Briefing chat assistant | ~1.5 wk | **High** |
| 4.2 | AI | Thread/line/globe assistant | ~3–4 d | Medium |
| 4.3 | AI | Persistent assistant (Pro+ only) | ~2 wk | Medium |
| 4.4 | AI | Safety guardrails | cross-cutting | **Required** |

**Total estimated effort if everything ships: ~5–6 months of focused work.**

---

## Suggested v2 sequencing

A realistic post-launch sequence that respects dependencies:

### Sprint 1 (3–4 weeks): "Briefing depth"
- 1.3 Earthquake overlay (huge ROI, ~2d)
- 1.5 Sentiment heatmap (~2d)
- 1.4 Coverage panel desktop (~2d)
- 1.2 Climate overlays — fires + drought (~1.5wk)
- 1.6.1 Wire photos from existing OG tags (~1d)
- 1.6.2 Local-broadcast clips (~3d)

### Sprint 2 (4–5 weeks): "Wireframe identity"
- 2.1 Foundation + Mapbox proxy
- 2.2 Briefing pre-rendered MP4
- 2.3 Briefing UI integration

Track 2 is intentionally a single concentrated push. The wireframe scenes
either land as a unified visual upgrade or they don't — half-shipped looks
worse than nothing.

### Sprint 3 (3 weeks): "Trade flows + documentary depth"
- 1.1 Sankey commodity flows (~1wk)
- 1.6.5 DocumentCloud integration (~1wk)
- 1.6.7 Oyez court audio (~3d)

### Sprint 4 (3 weeks): "Social — reactions + comments"
- 3.1 Reactions (~3d)
- 3.2 Comments (~2wk)
- 4.4 AI safety guardrails framework

### Sprint 5 (3 weeks): "AI assistant"
- 4.1 Briefing chat assistant (~1.5wk)
- 4.2 Thread/line/globe assistant (~4d)

### Sprint 6 (3 weeks): "Live chat"
- 3.3 Live chat during briefings

### Sprint 7 (3 weeks): "Forum"
- 3.4 Forum (Events category first)

### Sprint 8 (2 weeks): "Wireframe interactivity"
- 2.4 Thread interactive scenes
- 2.5 Timeline interactive scenes

### Sprint 9 (2 weeks): "Diarization stack"
- 1.6.3 + 1.6.4 Press conference + gov audio (~2wk together)

### Sprint 10 (2 weeks): "Premium assistant"
- 4.3 Persistent Pro+ assistant
- 2.6 Wireframe polish + perf

**Cumulative: ~6 months from v1-launch to v2-complete.** In practice,
sprints will overlap and reorder based on user feedback after launch.

---

## What's deliberately NOT in v2

| Item | Why not | Where it goes |
|---|---|---|
| Photoreal Google 3D Tiles deep zoom | Aesthetics conflict with wireframe identity | `GOOGLE_3D_TILES_ANALYSIS.md` — post-v2 if at all |
| Volumetric phenomena at production grade | 4–8 wks per phenomenon | v3 |
| Historic-borders time-rewind | Specialized animation pipeline | v3 |
| Camera dive into 3D city via Google Tiles | Heavy + non-trivial billing | post-v2 |
| Multi-perspective AI character interviews | Editorial policy work needed first | post-Track-4 |
| Counterfactual narrator mode | Editorial policy work needed first | post-launch + policy |
| Text-to-video synthesized B-roll (Sora-class) | Quality + legal exposure | revisit 6–12 months |
| AI-generated diorama (text-to-3D GLB) | Quality not there yet | revisit 12 months |
| DM / direct messages | Out of scope for v2 social | v3 |
| Friend / follow graph | Out of scope for v2 social | v3 |
| Real-name verification | Identity model TBD | v3+ |
| Mobile app push notifications | Capacitor work + APNs setup | post-v2 |

---

## Operating principles for v2

A few cross-cutting rules captured for the next time we sit down with this
doc:

1. **The heatmap-AI is the orchestration layer.** Every new featured-media
   type is a tool the heatmap-AI can call. Don't build parallel orchestration
   systems — extend the existing one.
2. **Free + reliable + open beats paid + flashy.** Comtrade > Reuters; USGS
   > paid seismic feeds; NASA GIBS > paid satellite vendors. We can graduate
   to paid sources if free ones bottleneck specific stories.
3. **Mobile constraints are the design constraint.** Anything that doesn't
   fit on a 375×812 viewport with a thumb in the way is a desktop-only or
   v3 feature.
4. **Ship vertical slices, not horizontal layers.** A working Sankey for
   wheat alone beats a half-built ingest for 20 commodities. Same applies
   per-feature within tracks.
5. **Each new feature's failure mode is "not present," not "broken."**
   Reactions failing → reactions hidden, not error toast. Live chat down →
   chat panel collapsed, briefing keeps playing. Wireframe scene render
   failed → static hero image fallback. Etc.
6. **Editorial choices are not engineering choices.** If a feature requires
   a position on contested topics (counterfactual narrator, multi-perspective
   interviews), that's a policy conversation first, not a build ticket.
7. **The product is the daily briefing.** Everything in v2 should reinforce
   that loop, not distract from it. If a feature pulls people away from the
   briefing as the central ritual, it's the wrong feature.

---

## Revisit cadence

- **Monthly** — review progress against the sequencing above; reorder based
  on usage analytics from V1
- **Quarterly** — reassess what's tabled; pull anything in if conditions
  changed (e.g., text-to-video quality jumped, social demand emerged, etc.)
- **At v2 → v3 boundary** — full re-write of this doc; v3 starts from
  "what did v2 actually ship and what did users actually want?"

Last updated: 2026-05-09 (drafted alongside V1 launch prep).
