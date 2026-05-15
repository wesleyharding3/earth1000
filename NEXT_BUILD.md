# Earth00 — Next Build Plan (post-1.0.0)

Working list of fixes and features to bundle into the next iOS build.
Items are grouped by where they live so we know which ones need an
Xcode build cycle vs which deploy independently to Render.

────────────────────────────────────────────────────────────────────
## NEW IN THIS BUILD — needs Apple review pass
────────────────────────────────────────────────────────────────────

### Features

- [ ] **Media slideshow on briefings + earth-editor**
  - Briefing segments cycle through a slideshow of article images
    while narration plays, instead of just one static hero or focal
    video.
  - Earth editor: add a slideshow picker per segment so we can curate
    which images appear and in what order.
  - Source: article image_url + image_assets bucket fallbacks already
    populated by backfillImages.js.

- [ ] **"Labels" checkbox on briefings**
  - User-toggleable: show / hide segment-level country + city labels
    on the globe during briefing playback.
  - Default ON. Persist preference per user (Capacitor Preferences +
    Supabase).

- [ ] **Tier-1 watermark on briefing playback** (Pro/Enterprise content)
  - Low-opacity layer: `earth00.com · {user.email} · YYYY-MM-DD`
  - Diagonal repeated pattern, ~15–20% opacity
  - Shown only while briefing is active
  - Identifies the leaker if a clip gets reposted; doesn't degrade
    the viewing experience for legit users

- [ ] **Collapsible search field on Threads + Lines lists**
  - Small magnifier icon in the threads / timelines view header;
    tap to expand into a search input pinned to the top of the list
  - Filters the grid in-place by title (and maybe keywords / nation
    codes) without re-fetching — purely client-side over the already-
    loaded `activeGridData`
  - Collapses back to icon when cleared or tapped away
  - Files: `www/index.html` + `index.html` (root) — the threads/
    timelines header + `renderThreads()` / `appendGridPage()` filter
    plumbing

- [ ] **Pie-graph data panel: shareable as image**
  - Add a small share icon on each pie/donut data panel during
    briefing playback (and in the standalone panel renderer)
  - Tap → composes a 1080×1350 image with the pie chart + labels
    + thread/segment title + earth00.com chrome; dispatches via
    `__shareSnapshot`
  - Use the existing `shareImageGenerator.js` SVG → PNG path with
    a new `pieChart` template variant so the chart renders crisp
    at any output resolution
  - Files: `dataPanelGenerator.js` (panel definitions),
    `shareImageGenerator.js` (new variant), www/index.html + root
    (the share-button wiring next to the panel)

- [ ] **Desktop: explicit Download option on images + clips**
  - Current behavior on desktop: `_snapDispatch` and `__shareGlobeClip`
    silently fall back to an `<a download>` click when `navigator.share`
    can't accept files (desktop Chrome/Firefox). The file lands in
    Downloads with only a brief toast, so users assume the action
    failed.
  - New: when running on desktop (no `Capacitor.isNativePlatform()`,
    no `navigator.canShare({ files })`), the popover should label
    its actions **"Download Image"** and **"Download Clip"** instead
    of just "Image" / "Clip" — making the outcome obvious from the
    click target.
  - Bonus: after the download fires, show a clearer toast like
    *"Image saved to Downloads: earth00-1234.png"* with the filename
    so users can find it.
  - Mobile (iOS Capacitor, mobile Safari, Android Chrome) keeps
    "Share" / "Image" / "Clip" labels — share sheet path is intact.
  - Files: `index.html` (root, desktop) primarily;
    `_attachClusterShareBtn`, `_attachFlowCtxSharePopover`,
    `_attachHeatmapShareBtn`, and the showToast calls in
    `_snapDispatch` + `__shareGlobeClip` desktop fallback paths.

### Bug fixes

- [ ] **United States not filled in on briefings (investigate)**
  - Repro: open today's briefing, look at any US-relevant segment —
    the US polygon isn't highlighted even when the story is about the US.
  - Hypothesis: the ISO resolver in `briefingGenerator.js` (or the
    runtime highlight path) is missing the "US" / "U.S." / "America"
    alias, OR the secondary_country_isos doesn't include US.
  - Look at: `primary_country_iso` + `secondary_country_isos` for a
    Trump-headline segment; trace why US isn't reaching the highlight
    overlay.

- [ ] **Pie-graph panel: split circle from labels**
  - Current: pie chart + legend labels stack in one panel that
    overlaps the globe.
  - New: just the donut/pie circle floats over the globe; labels
    move into a separate smaller side panel.
  - Files: `dataPanelGenerator.js` (server-side panel definitions)
    + the briefing player's panel renderer in www/index.html.

- [ ] **Heatmap + News Flows shareable content: 2D map handling**
  - When projection is in 2D map mode (`window.__projection === 'map'`),
    the share image/clip should render the 2D map view faithfully —
    not fall back to the globe or produce a malformed capture.
  - Verify `_snapCaptureView()` and `__shareSnapshot()` both honor the
    projection flag end-to-end for heatmap + news-flows surfaces.
  - Also: the subtitle/badge should reflect "2D MAP" instead of
    "GLOBE" when in map mode (already partially handled but verify).

- [ ] **"Map This" override of keyword / time-series in share content**
  - Current: when a user has a keyword or time-series heatmap rendered
    and the share path runs, the "Map This" AI question (if previously
    set in `panel.dataset.qaQuestion`) overrides the active keyword /
    mode in the share image's title + caption — sharing the wrong view.
  - New: prefer whichever mode is CURRENTLY ACTIVE on the heatmap
    (the active mode pill / the displayed visualization) over a stale
    qaQuestion that's no longer the live view.
  - Files: `_attachHeatmapShareBtn` (both `www/index.html` and
    `index.html` root) — specifically the `_doSnapshot` / `_doClip`
    branches that compose `shareTitle`, `shareText`, `overlayTitle`,
    `overlaySubtitle`.

- [ ] **"Map This" country-panel doesn't update when mode switches back to keyword**
  - Repro: open heatmap → switch to "Map This" mode → ask a question →
    tap a country on the globe; the country panel opens with Map-This
    context (rationale, in-bucket / out-of-bucket flag). Switch the
    heatmap mode back to **keyword** — the previously-open country
    panel still shows the stale Map-This content instead of refreshing
    to the keyword-mode info for that country.
  - Expected: switching heatmap mode while a country panel is open
    should either (a) re-render the panel against the new mode's data
    for that country, or (b) close the panel since the prior context
    is no longer valid.
  - Files: heatmap mode-pill change handler (around the `semHeatPanel`
    mode-switch logic) — needs to fire a refresh on any open country
    panel. Also check the country-panel renderer's source-of-truth
    for which heatmap mode it reads from (likely captures it at open
    time and never re-reads).

- [ ] **Increase font size for labels + branding on shareable content**
  - Current: labels (titles, subtitles, badges, date pills, flag-chip
    legends, scope line "COVERAGE IN …", earth00.com footer) read as
    smaller than they should on Reels/Stories at thumbnail size — feed
    skimmers can't parse them in the 0.5-second pass.
  - New: bump font sizes across all branded share artifacts (clip
    overlay + snapshot composite + briefing-segment card):
      - Title: 3.8% width → **4.2-4.5% width**
      - Subtitle: 2.2% width → **2.6-2.8% width**
      - Date pill: 2.2% width → **2.6% width**
      - earth00.com footer: 2.4% width → **3.0% width**
      - Scope line: 2.0% width → **2.4% width**
  - Verify against the 4:5 (1080×1350) clip and 9:16 reel sizes —
    sizes should scale with canvas width so they stay readable on
    feed thumbnails.
  - Files: `_buildClipOverlayPainter` + `_snapComposite` in both
    `www/index.html` and `index.html` root; also the briefing-segment
    card builder in `scripts/exportBriefingSegments.js` for parity.

### Polish already coded, not yet shipped (in www/ since build 4)

- [ ] **Image-share silent fail** — Capacitor `Share.share` URL-field
      shape (mirrors __shareGlobeClip)
- [ ] **Date range + flag chip row on clip overlay** — wired through
      `_doClip` → `__shareEntityClip` → `_buildClipOverlayPainter`
- [ ] **4:5 clip aspect ratio (1080×1350)** — replaces square 1:1;
      restores top/bottom of globe
- [ ] **Title 3-line wrap + auto-shrink for long titles** in clip
      overlay (e.g. "Beijing Condemns Paraguay Taiwan Visit…")
- [ ] **`_isClipSupported` click-time check** so Clip option appears
      in all popovers (flow-ctx, cluster, heatmap)
- [ ] **Date range on line cards** — `earliest_published_at` field
      now returned by /api/timelines/latest

### Pre-flight before submitting build

- [ ] Bump CFBundleVersion to 5 in Xcode
- [ ] Bump CFBundleShortVersionString to **1.0.1** (or 1.1.0 if
      counting the slideshow + labels as features rather than fixes)
- [ ] `cap sync ios` — pushes the latest `www/` into the Xcode
      workspace
- [ ] Archive → Distribute → Upload
- [ ] Wait ~15-30 min for processing, attach to 1.0.1 version in
      App Store Connect, submit for review
- [ ] **Use Phased Release** for the rollout (1% → 100% over 7 days);
      catches any regression before it hits everyone

────────────────────────────────────────────────────────────────────
## SERVER-SIDE — deploy independently to Render, NO build needed
────────────────────────────────────────────────────────────────────

- [ ] **Briefing generator: classifier-derived primary/secondary**
      (already coded — needs push). Pulls primary_nations +
      secondary_nations into briefing segments, auto-generates flow
      arcs from primary↔secondary classifier pairs. Fixes the "US
      not filled" symptom for many segments.
- [ ] **Earth-editor auto-refresh** (already coded — needs push).
      Loads Supabase SDK + `autoRefreshToken` so admin sessions don't
      expire after 1 hour.
- [ ] **`_buildTieredFlows` start_date/end_date** on /api/flows/* —
      already coded, needs push so line cards + share clips can read
      it.
- [ ] **Cache key bumps** on flows + timelines/latest (already coded)
      so the new fields actually serve.
- [ ] **TIER_MAX_SECONDARIES comment fix** in server.js (cosmetic,
      already coded)

### Supabase dashboard (manual, ~60 sec each)

- [ ] **Bump JWT expiry** to 86400 (24h) — Project Settings →
      Auth → Access Token JWT Expiry. Reduces editor auto-refresh
      cycles from 24/day to 1/day.

────────────────────────────────────────────────────────────────────
## DESKTOP (root index.html) — push to Render, immediate
────────────────────────────────────────────────────────────────────

- [ ] Same polish set as the iOS list above (image-share fix, date
      range, 4:5 clip, title wrap, etc.) — already coded in root
      index.html, just needs push.

────────────────────────────────────────────────────────────────────
## v2 IDEAS — track for after first round of post-launch metrics
────────────────────────────────────────────────────────────────────

- 3D historical tile corpus ("what this region looked like in 2014
  vs today") — biggest viral share lever
- User-facing data-viz pipeline ("Substack for geographic news
  intelligence")
- Playwright-based automated briefing-segment recorder (zero daily
  labor for content factory)
- iOS-native screen-capture detection (Tier 2 anti-leak)
- Personalized briefing topics + scheduled push notifications when
  the user's tracked stories advance

- *("Map This" on News Flows moved to V2_ROADMAP.md Track 1.7)*

- **Heatmap: categorical / multi-mode beyond binary** — extend the
  heatmap from boolean (in/out of the answer set) to N-category
  coloring. User asks "classify each country's stance on the Iran
  nuclear deal" → AI returns each country tagged into one of
  N buckets (e.g. "supports", "opposes", "neutral", "leveraging").
  Each bucket gets its own color from the brand palette; legend
  panel maps colors → buckets with one example country each.
  Implementation:
    - New `heatmap_mode = 'categorical'` (alongside existing 'binary',
      'sentiment', 'coverage')
    - Claude returns `{ [iso]: { bucket: 'supports', confidence: 0.85,
      rationale: '...' } }` instead of binary `{ [iso]: true|false }`
    - Server-side: cache by `(question + bucket_count)`
    - Client: polygon shader interpolates color from N-stop palette
      keyed on bucket index; legend renders as a stacked card
  Bonus: lets users do "Map This: best Earth00 case studies" /
  "Map This: best food destinations" etc. — anything classifiable
  into 3-5 buckets, not just yes/no.

────────────────────────────────────────────────────────────────────

Last updated: 2026-05-14
