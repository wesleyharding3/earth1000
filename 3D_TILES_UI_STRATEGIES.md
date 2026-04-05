# 10 UI Integration Strategies for Google 3D Tiles

## Overview
Each strategy represents a different UX philosophy for integrating 3D Tiles into your globe interface. Choose based on your users' analysis depth, device capabilities, and intended workflows.

---

## Strategy 1: "Immersive Deep Dive"
### UX Pattern: Full-screen 3D detail view with progressive disclosure

**How it Works:**
- User clicks event on globe → Smooth camera flight to location
- Globe fades out, replaced with photorealistic 3D tileset
- Event markers float on 3D terrain with glowing halos
- Panel slides in from side showing article context + spatial metrics

**Design Details:**
```
Before Click:          Click Event:              After Landing:
┌─────────────┐        └──────────┘              ┌─────────────────┐
│             │                                  │  3D TERRAIN     │
│  Globe      │         ▼▼▼                      │                 │
│   •Event    │    Flying...                    │      •Event     │
│             │                                  │    🏢🏢        │
└─────────────┘                                 │                 │
                                                 ├─────────────────┤
                                                 │ Articles        │
                                                 │ Spatial Context │
                                                 └─────────────────┘
```

**Implementation Code:**
```javascript
async function diveIntoLocation(eventId) {
  const event = getEventData(eventId);

  // Animation phase
  await animateCamera(
    currentPos,
    { lat: event.lat, lon: event.lon, altitude: 500 }, // 500m above
    duration: 2000
  );

  // Load tileset
  const tileset = await tilesetManager.loadTilesetForLocation(
    event.lat,
    event.lon,
    zoomLevel: 19 // High detail
  );

  // Fade transitions
  gsap.to(globeGroup, { opacity: 0, duration: 1 });
  gsap.to(tilesetContainer, { opacity: 1, duration: 1 });

  // Show event markers on 3D terrain
  const eventMarkers = await eventOverlayManager.loadAndProjectEvents(event);

  // Slide in detail panel
  showLocationPanel(event, eventMarkers);
}
```

**Best For:** Users wanting to understand event context at "street level"

**Performance:** Medium (1 tileset loaded, 50-100 event markers)

---

## Strategy 2: "Picture-in-Picture Analytics"
### UX Pattern: Small 3D viewport in corner while maintaining globe context

**How it Works:**
- Keep globe as main view
- Small 3D tileset window (20% screen) in bottom-right
- Shows detailed terrain of hovered location
- Updates in real-time as user hovers different regions

**Design Layout:**
```
┌─────────────────────────────────────────────┐
│                                             │
│           Main Globe View                   │
│                                             │
│                                             │  ┌──────────────┐
│                                             │  │  3D Detail   │
│                                             │  │  (Hover)     │
│         Events & Regions                   │  │              │
│                                             │  │  🏢 🏢      │
│                                             │  │              │
│                                             │  └──────────────┘
└─────────────────────────────────────────────┘
```

**Implementation:**
```javascript
const miniViewport = {
  width: window.innerWidth * 0.25,
  height: window.innerHeight * 0.25,
  position: { right: 20, bottom: 20 }
};

// Use WebGL rendering to texture
const miniRenderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true
});

function onGlobeHover(lat, lon) {
  // Load tileset for mini view
  if (currentMiniTileset?.id !== getTileId(lat, lon)) {
    tilesetManager.loadTilesetForLocation(lat, lon, zoom: 18)
      .then(tileset => {
        miniScene.clear();
        miniScene.add(tileset);
        currentMiniTileset = tileset;
      });
  }

  // Update mini camera to look at location
  miniCamera.position = calculateCameraPos(lat, lon, altitude: 200);
  miniCamera.lookAt(latLonToVector3(lat, lon));
}

// Render both views each frame
function animate() {
  renderer.render(scene, camera);           // Main view
  miniRenderer.render(miniScene, miniCamera); // Detail view
  requestAnimationFrame(animate);
}
```

**Best For:** Users who want context + detail simultaneously

**Performance:** High (2 scenes rendering, careful LOD needed)

**Challenge:** Dual rendering can impact performance; may need to reduce mini viewport detail level

---

## Strategy 3: "Timeline Scrubber"
### UX Pattern: Time slider loads different tileset versions, shows terrain changes

**How it Works:**
- Timeline slider at bottom shows historical tileset availability
- Drag slider to move through time
- 3D terrain updates to show how terrain/buildings changed
- Highlight demolished areas (red) and new construction (green)

**Visual Design:**
```
TIME SLIDER (Bottom of screen)
├─ 2019: Basic buildings
├─ 2020: Building density increase
├─ 2021: New major development
├─ 2022: Road expansion
└─ 2024: Current

Timeline shows:
  🟩 New buildings (green highlight)
  🟥 Demolished/cleared (red highlight)
  ⚪ Unchanged (normal)
```

**Implementation:**
```javascript
class TemporalTilesetView {
  constructor(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this.availableYears = [2019, 2020, 2021, 2022, 2023, 2024];
    this.currentYear = 2024;
    this.tilesets = new Map();
    this.changes = new Map();
  }

  async loadTimeSeriesData() {
    // Load all available tilesets for location
    const promises = this.availableYears.map(year =>
      tilesetManager.loadTilesetForLocation(
        this.lat,
        this.lon,
        year: year,
        zoomLevel: 19
      )
    );

    const tilesets = await Promise.all(promises);
    this.availableYears.forEach((year, i) => {
      this.tilesets.set(year, tilesets[i]);
    });

    // Analyze changes between years
    this.analyzeChanges();
  }

  analyzeChanges() {
    for (let i = 0; i < this.availableYears.length - 1; i++) {
      const year1 = this.availableYears[i];
      const year2 = this.availableYears[i + 1];

      const changes = this.compareGeometry(
        this.tilesets.get(year1),
        this.tilesets.get(year2)
      );

      this.changes.set(`${year1}-${year2}`, {
        newBuildings: changes.added,
        demolished: changes.removed,
        renovated: changes.modified,
      });
    }
  }

  compareGeometry(tileset1, tileset2) {
    // Compare point clouds from two tilesets
    // Return diff: added vertices, removed vertices, modified
    return {
      added: [],
      removed: [],
      modified: [],
    };
  }

  onTimelineChange(year) {
    this.currentYear = year;

    // Fade current
    gsap.to(this.tilesets.get(this.currentYear - 1), { opacity: 0 });

    // Fade in new
    gsap.to(this.tilesets.get(year), { opacity: 1 });

    // Highlight changes from previous year
    const prevYear = this.availableYears[this.availableYears.indexOf(year) - 1];
    if (prevYear) {
      const changeData = this.changes.get(`${prevYear}-${year}`);
      this.visualizeChanges(changeData);
    }
  }

  visualizeChanges(changeData) {
    // Add green halos to new buildings
    changeData.newBuildings.forEach(building => {
      this.addHighlight(building, 'green', 0.6);
    });

    // Add red halos to demolished areas
    changeData.demolished.forEach(area => {
      this.addHighlight(area, 'red', 0.6);
    });
  }
}

// UI Timeline
const timelineSlider = document.querySelector('#timelineSlider');
timelineSlider.addEventListener('input', (e) => {
  const selectedYear = parseInt(e.target.value);
  temporalView.onTimelineChange(selectedYear);
});
```

**Best For:** Analyzing how regions develop over time, tracking infrastructure projects

**Data Source:** Google Maps Timeseries tileset

**Performance:** High overhead (loading multiple full tilesets); consider loading on-demand per year

---

## Strategy 4: "Heatmap Overlay"
### UX Pattern: 3D terrain with event density visualization

**How it Works:**
- 3D tileset rendered with semi-transparent overlay
- Heatmap colors show event concentration (red = high, blue = low)
- Hover shows specific event type breakdown
- Can toggle heatmap layer on/off

**Visual Effect:**
```
┌─────────────────────────┐
│   3D Terrain            │
│  🌡️ Heatmap Overlay    │
│                         │
│ High density: 🔴🔴🟠   │
│ Med density:  🟡🟢     │
│ Low density:  🔵       │
│                         │
└─────────────────────────┘
```

**Implementation:**
```javascript
class HeatmapOverlayManager {
  constructor(tileset) {
    this.tileset = tileset;
    this.eventDensityGrid = [];
    this.heatmapTexture = null;
    this.gridResolution = 50; // 50x50 grid
  }

  async buildDensityGrid(events) {
    // Create grid covering tileset bounds
    const bounds = this.tileset.boundingBox;
    const cellWidth = bounds.width / this.gridResolution;
    const cellHeight = bounds.height / this.gridResolution;

    // For each cell, count events inside
    for (let x = 0; x < this.gridResolution; x++) {
      for (let y = 0; y < this.gridResolution; y++) {
        const cellBounds = {
          min: new THREE.Vector3(
            bounds.min.x + x * cellWidth,
            bounds.min.y + y * cellHeight,
            bounds.min.z
          ),
          max: new THREE.Vector3(
            bounds.min.x + (x + 1) * cellWidth,
            bounds.min.y + (y + 1) * cellHeight,
            bounds.max.z
          ),
        };

        const eventsInCell = events.filter(e =>
          this.isInBounds(e.position, cellBounds)
        );

        this.eventDensityGrid[x] = this.eventDensityGrid[x] || [];
        this.eventDensityGrid[x][y] = {
          count: eventsInCell.length,
          eventTypes: this.categorizeByType(eventsInCell),
        };
      }
    }

    // Normalize to 0-1
    const maxCount = Math.max(...this.eventDensityGrid.flat().map(c => c.count));
    this.eventDensityGrid = this.eventDensityGrid.map(row =>
      row.map(cell => ({ ...cell, normalized: cell.count / maxCount }))
    );
  }

  createHeatmapTexture() {
    // Create canvas-based texture for heatmap
    const canvas = document.createElement('canvas');
    canvas.width = this.gridResolution;
    canvas.height = this.gridResolution;

    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(this.gridResolution, this.gridResolution);
    const data = imageData.data;

    for (let i = 0; i < this.eventDensityGrid.length; i++) {
      for (let j = 0; j < this.eventDensityGrid[i].length; j++) {
        const cellData = this.eventDensityGrid[i][j];
        const density = cellData.normalized;

        const color = this.densityToColor(density);
        const pixelIndex = (j * this.gridResolution + i) * 4;

        data[pixelIndex] = color.r;
        data[pixelIndex + 1] = color.g;
        data[pixelIndex + 2] = color.b;
        data[pixelIndex + 3] = 200; // Alpha for transparency
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return new THREE.CanvasTexture(canvas);
  }

  densityToColor(normalized) {
    // Blue (low) → Green → Yellow → Red (high)
    if (normalized < 0.25) {
      return { r: 0, g: 0, b: 255 };
    } else if (normalized < 0.5) {
      return { r: 0, g: 255, b: 0 };
    } else if (normalized < 0.75) {
      return { r: 255, g: 255, b: 0 };
    } else {
      return { r: 255, g: 0, b: 0 };
    }
  }

  applyHeatmapToTileset() {
    // Create overlay plane matching tileset
    const overlayMaterial = new THREE.MeshStandardMaterial({
      map: this.heatmapTexture,
      transparent: true,
      opacity: 0.4,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.2,
    });

    const overlayMesh = new THREE.Mesh(
      this.tileset.geometry,
      overlayMaterial
    );

    // Offset slightly above terrain to avoid z-fighting
    overlayMesh.position.z += 0.01;
    this.tileset.add(overlayMesh);
  }

  onCellHover(gridX, gridY) {
    const cellData = this.eventDensityGrid[gridX][gridY];

    // Show breakdown
    const tooltip = `
      Events: ${cellData.count}
      Conflicts: ${cellData.eventTypes.conflict || 0}
      Disasters: ${cellData.eventTypes.natural_disaster || 0}
      Other: ${cellData.eventTypes.other || 0}
    `;

    showTooltip(tooltip);
  }
}
```

**Best For:** Seeing overall event distribution, identifying hotspots

**Performance:** Medium (texture overlay, no extra geometry)

---

## Strategy 5: "Augmented Reality Spillover"
### UX Pattern: 3D terrain in viewport, AR anchor points for mobile

**How it Works:**
- On desktop: Shows tileset in detail view
- On mobile: Creates AR markers that align with real-world camera feed
- User can point phone at location and see event history overlaid
- Markers anchor to physical buildings in 3D space

**Implementation:**
```javascript
async function setupARView(eventId, lat, lon) {
  // Check device capability
  const arSupported = await navigator.xr?.isSessionSupported('immersive-ar');

  if (arSupported) {
    // Create XR session
    const session = await navigator.xr.requestSession('immersive-ar');

    // Load tileset data (lightweight for AR)
    const tilesetData = await fetch(
      `/api/tiles/ar?lat=${lat}&lon=${lon}&detail=low`
    ).then(r => r.json());

    // Create AR anchors for events
    const events = await eventOverlayManager.loadEventsForLocation(lat, lon);

    events.forEach(event => {
      const anchor = session.createAnchor(
        event.geoLocation, // Geospatial anchor
        {
          role: 'event-marker',
          type: event.type,
          articles: event.articles,
        }
      );

      // Render lightweight 3D marker
      const marker = createARMarker(event);
      session.addReferenceSpace(anchor, marker);
    });

    startARRenderLoop(session);
  }
}
```

**Best For:** Mobile users wanting immersive location understanding, tourist experiences

**Challenges:** AR requires geospatial tracking; Google Maps AR needs specialized APIs

---

## Strategy 6: "Comparative Split View"
### UX Pattern: Before/after comparison, side-by-side tilesets

**How it Works:**
- Left side: Historical tileset (2010)
- Right side: Current tileset (2024)
- Draggable divider in middle to reveal/hide
- Synchronized cameras on both sides
- Shows urban development over 14 years

**Layout:**
```
┌────────────────┬────────────────┐
│  2010 Terrain  │  2024 Terrain  │
│   (Buildings)  │ (Development)  │
│                │◄───DRAG───►   │
│  🏢 🏢         │  🏢🏢🏢🏢    │
└────────────────┴────────────────┘
```

**Implementation:**
```javascript
class ComparativeView {
  constructor(lat, lon) {
    this.lat = lat;
    this.lon = lon;

    // Create two side-by-side canvases
    this.leftCanvas = document.createElement('canvas');
    this.rightCanvas = document.createElement('canvas');

    this.leftRenderer = new THREE.WebGLRenderer({ canvas: this.leftCanvas });
    this.rightRenderer = new THREE.WebGLRenderer({ canvas: this.rightCanvas });

    // Split screen layout
    this.setupSplitView();
  }

  setupSplitView() {
    const container = document.getElementById('compareContainer');
    container.style.display = 'flex';

    this.leftCanvas.style.width = '50%';
    this.rightCanvas.style.width = '50%';

    container.appendChild(this.leftCanvas);
    container.appendChild(this.rightCanvas);

    // Draggable divider
    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    divider.draggable = true;

    divider.addEventListener('drag', (e) => {
      const percentage = (e.clientX / window.innerWidth) * 100;
      this.leftCanvas.style.width = `${percentage}%`;
      this.rightCanvas.style.width = `${100 - percentage}%`;
    });

    container.appendChild(divider);
  }

  async loadBothTilesets() {
    const [historical, current] = await Promise.all([
      tilesetManager.loadTilesetForLocation(
        this.lat, this.lon,
        year: 2010, zoomLevel: 19
      ),
      tilesetManager.loadTilesetForLocation(
        this.lat, this.lon,
        year: 2024, zoomLevel: 19
      ),
    ]);

    this.historicalScene = new THREE.Scene();
    this.currentScene = new THREE.Scene();

    this.historicalScene.add(historical);
    this.currentScene.add(current);

    // Sync cameras
    this.leftCamera = new THREE.PerspectiveCamera(60, 0.5, 0.1, 1000);
    this.rightCamera = new THREE.PerspectiveCamera(60, 0.5, 0.1, 1000);

    this.syncCameras();
  }

  syncCameras() {
    // When user rotates on one side, rotate both
    const controls1 = new THREE.OrbitControls(this.leftCamera, this.leftCanvas);
    const controls2 = new THREE.OrbitControls(this.rightCamera, this.rightCanvas);

    controls1.addEventListener('change', () => {
      this.rightCamera.position.copy(this.leftCamera.position);
      this.rightCamera.quaternion.copy(this.leftCamera.quaternion);
    });
  }

  animate() {
    this.leftRenderer.render(this.historicalScene, this.leftCamera);
    this.rightRenderer.render(this.currentScene, this.rightCamera);
    requestAnimationFrame(() => this.animate());
  }
}
```

**Best For:** Urban planners, journalists documenting development, environmental analysis

**Performance:** High overhead (2 full scenes); may need lower LOD for each side

---

## Strategy 7: "Floating Card Carousel"
### UX Pattern: Cards showing events, swipe to rotate 3D view to match

**How it Works:**
- Tileset in main view with minimal UI
- Cards at bottom showing individual events
- Swipe cards to rotate/pan camera to each event location
- Smooth animation between card selections
- Tap card for detailed analysis

**Design:**
```
┌─────────────────────────────────┐
│       3D Terrain View           │
│          (rotating)             │
│                                 │
│            🏢 ← rotates         │
│                                 │
├─────────────────────────────────┤
│ ◄ [Event 1] [Event 2] [Event 3] ►
│    ↑ Active (highlighted)
└─────────────────────────────────┘
```

**Implementation:**
```javascript
class CardCarousel {
  constructor(eventMarkers) {
    this.eventMarkers = eventMarkers;
    this.currentIndex = 0;
    this.container = document.getElementById('cardCarousel');

    this.renderCards();
    this.setupSwipeDetection();
  }

  renderCards() {
    this.container.innerHTML = '';

    // Show 3 cards at a time
    const visibleCards = this.eventMarkers.slice(
      Math.max(0, this.currentIndex - 1),
      Math.min(this.eventMarkers.length, this.currentIndex + 2)
    );

    visibleCards.forEach((event, idx) => {
      const isActive = idx === 1;
      const card = this.createCard(event, isActive);
      this.container.appendChild(card);
    });
  }

  createCard(event, isActive) {
    const card = document.createElement('div');
    card.className = `event-card ${isActive ? 'active' : ''}`;
    card.innerHTML = `
      <div class="card-header">
        <h3>${event.title}</h3>
        <span class="event-type ${event.type}">${event.type}</span>
      </div>
      <p class="location">${event.location}</p>
      <p class="snippet">${event.summary}</p>
      <div class="event-metrics">
        <span>Elevation: ${event.elevation}m</span>
        <span>Nearby Events: ${event.nearbyCount}</span>
      </div>
    `;

    card.addEventListener('click', () => this.focusEvent(event));
    card.addEventListener('swipeleft', () => this.nextCard());
    card.addEventListener('swiperight', () => this.prevCard());

    return card;
  }

  focusEvent(event) {
    // Animate camera to face event marker
    const targetPos = event.worldPos;

    new TWEEN.Tween(this.camera.position)
      .to(
        {
          x: targetPos.x * 1.2,
          y: targetPos.y * 1.2,
          z: targetPos.z * 1.2,
        },
        1000
      )
      .easing(TWEEN.Easing.Cubic.InOut)
      .start();

    // Highlight marker
    this.highlightMarker(event.id);

    // Show detailed panel
    showEventDetailPanel(event);
  }

  nextCard() {
    this.currentIndex = Math.min(
      this.currentIndex + 1,
      this.eventMarkers.length - 1
    );
    this.renderCards();
    this.focusEvent(this.eventMarkers[this.currentIndex]);
  }

  prevCard() {
    this.currentIndex = Math.max(this.currentIndex - 1, 0);
    this.renderCards();
    this.focusEvent(this.eventMarkers[this.currentIndex]);
  }
}
```

**Best For:** Story-driven exploration, curated event sequences

**Performance:** Low (single tileset, light card updates)

---

## Strategy 8: "3D Briefing Panel"
### UX Pattern: Traditional briefing layout, but with embedded 3D viewport

**How it Works:**
- Keep familiar briefing UI (left side articles, timeline)
- Right side has mini 3D terrain viewport showing article locations
- Click article → Camera flies to location in 3D view
- Text searches highlight locations on 3D terrain

**Layout:**
```
┌──────────────────────┬──────────────┐
│  Article 1           │   3D         │
│  Article 2           │  Viewport    │
│  Article 3           │   🏢 🏢     │
│  [Timeline]          │  (Mini view) │
│                      │  Highlight   │
│                      │  articles    │
└──────────────────────┴──────────────┘
```

**Implementation:**
```javascript
function enhanceBriefingWithMini3D(briefingData) {
  // Create mini 3D viewport
  const miniViewport = createMiniViewport(300, 400);
  const briefingPanel = document.querySelector('.briefingPanel');

  // Add 3D section to right side
  const threeDSection = document.createElement('div');
  threeDSection.className = 'briefing-3d-section';
  threeDSection.appendChild(miniViewport.canvas);

  briefingPanel.appendChild(threeDSection);

  // Link articles to 3D markers
  document.querySelectorAll('.article-item').forEach((articleEl, idx) => {
    articleEl.addEventListener('mouseenter', () => {
      const article = briefingData.articles[idx];
      const marker = miniViewport.getMarkerFor(article.location);

      if (marker) {
        // Highlight marker
        marker.material.emissive.setHex(0xffaa00);

        // Rotate camera to face it
        miniViewport.focusMarker(marker, duration: 500);
      }
    });

    articleEl.addEventListener('mouseleave', () => {
      miniViewport.resetView();
    });
  });

  // When user clicks article
  document.querySelectorAll('.article-item').forEach((articleEl, idx) => {
    articleEl.addEventListener('click', async () => {
      const article = briefingData.articles[idx];

      // In main globe, switch to detail view
      await switchToDetailView(article.location.lat, article.location.lon);

      // Highlight this article in 3D
      highlightArticleOnTerrain(article.id);
    });
  });
}
```

**Best For:** Journalists, analysts doing deep research

**Performance:** Medium (dual rendering: globe + mini viewport)

---

## Strategy 9: "Cluster Explosion"
### UX Pattern: 3D terrain with event clusters that expand/contract

**How it Works:**
- Zoom out → Events cluster into spheres
- Sphere size = number of events
- Hover sphere → See cluster statistics
- Click sphere → Explodes to show individual events in 3D
- Zoom back in → Events merge into new clusters

**Interaction Flow:**
```
Normal View:           Hover Cluster:       Explode View:
     🌍                   🔵                    •  •  •
    Events                ➜                   •     •
                    (shows count)             •  •  •
```

**Implementation:**
```javascript
class ClusterExplosion {
  constructor(events) {
    this.events = events;
    this.clusters = [];
    this.explosionState = new Map();
    this.buildClusters();
  }

  buildClusters() {
    // Use k-means clustering on event locations
    const kmeans = require('kmeans.js');

    const points = this.events.map(e => [e.position.x, e.position.y]);
    const k = Math.sqrt(this.events.length / 10); // Adaptive cluster count

    const result = kmeans(points, k);

    result.clusters.forEach((clusterPoints, idx) => {
      const clusterEvents = clusterPoints.map(point => {
        const eventIdx = points.findIndex(p => p === point);
        return this.events[eventIdx];
      });

      const centerPos = this.calculateClusterCenter(clusterEvents);

      const clusterSphere = new THREE.Mesh(
        new THREE.IcosahedronGeometry(10 + clusterEvents.length, 4),
        new THREE.MeshStandardMaterial({
          color: this.getClusterColor(clusterEvents),
          emissive: this.getClusterColor(clusterEvents),
          emissiveIntensity: 0.3,
        })
      );

      clusterSphere.position.copy(centerPos);
      clusterSphere.userData = {
        events: clusterEvents,
        isCluster: true,
        count: clusterEvents.length,
      };

      this.clusters.push(clusterSphere);
      scene.add(clusterSphere);
    });
  }

  onClusterClick(cluster) {
    // Animate explosion
    const explosionDuration = 800;

    cluster.userData.events.forEach((event, idx) => {
      const angle = (idx / cluster.userData.events.length) * Math.PI * 2;
      const distance = 100;

      const targetX = cluster.position.x + Math.cos(angle) * distance;
      const targetY = cluster.position.y + Math.sin(angle) * distance;
      const targetZ = cluster.position.z + (Math.random() - 0.5) * 50;

      new TWEEN.Tween(event.marker.position)
        .to({ x: targetX, y: targetY, z: targetZ }, explosionDuration)
        .easing(TWEEN.Easing.Elastic.Out)
        .start();

      // Show individual markers
      event.marker.visible = true;
    });

    // Hide cluster
    gsap.to(cluster, { opacity: 0, duration: explosionDuration / 1000 });

    this.explosionState.set(cluster.id, 'exploded');
  }

  onClusterCollapse(cluster) {
    // Reverse animation
    cluster.userData.events.forEach((event) => {
      new TWEEN.Tween(event.marker.position)
        .to(cluster.position, 600)
        .easing(TWEEN.Easing.Cubic.InOut)
        .start();
    });

    gsap.to(cluster, { opacity: 1, duration: 0.6 });

    this.explosionState.set(cluster.id, 'collapsed');
  }

  getClusterColor(events) {
    // Color by predominant event type
    const typeCounts = {};
    events.forEach(e => {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    });

    const dominantType = Object.keys(typeCounts).sort(
      (a, b) => typeCounts[b] - typeCounts[a]
    )[0];

    return this.eventTypeToColor(dominantType);
  }
}
```

**Best For:** Exploring dense event regions, understanding local clustering patterns

**Performance:** High (many animated objects; consider GPU instancing)

---

## Strategy 10: "AI-Guided Exploration"
### UX Pattern: AI agent suggests interesting viewing angles and analysis

**How it Works:**
- Claude/AI analyzes events and 3D terrain
- Recommends "interesting views" (e.g., "Best view of cluster from North")
- Suggests analysis queries (e.g., "Events near steep terrain", "Building proximity")
- Creates guided "narratives" through the data
- AI describes what's visible as camera moves

**Implementation:**
```javascript
class AIGuideExplorer {
  constructor(events, tileset, apiKey) {
    this.events = events;
    this.tileset = tileset;
    this.anthropic = new Anthropic({ apiKey });
  }

  async generateGuidedExploration() {
    // Prepare data for Claude
    const eventSummary = {
      count: this.events.length,
      types: this.categorizeEvents(),
      hotspots: this.identifyHotspots(),
      temporalPattern: this.analyzeTimePattern(),
    };

    const terrainSummary = {
      elevation_range: this.getElevationStats(),
      topography: this.describeTopography(),
      urban_coverage: this.analyzeUrbanDensity(),
    };

    // Ask Claude for insights
    const response = await this.anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `
You are an AI guide for exploring geospatial event data in 3D.

Events Summary:
${JSON.stringify(eventSummary, null, 2)}

Terrain Summary:
${JSON.stringify(terrainSummary, null, 2)}

Generate 3 "interesting viewing angles" that would reveal important patterns or relationships. For each:
1. Describe the viewing angle (elevation, azimuth, distance)
2. Explain what patterns become visible from this view
3. Suggest what analysis questions this view helps answer

Format as JSON array.
          `,
        },
      ],
    });

    const suggestions = JSON.parse(response.content[0].text);
    return suggestions;
  }

  async guidedNarrative() {
    const explorations = await this.generateGuidedExploration();

    // Sequentially show each exploration
    for (const exploration of explorations) {
      // Animate camera to viewing angle
      await this.animateCameraToAngle(exploration.angle);

      // Show narration
      const narration = await this.generateNarration(exploration);
      showNarrationPanel(narration);

      // Wait for user interaction
      await this.waitForUserInput();
    }
  }

  async generateNarration(viewingAngle) {
    const response = await this.anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `
You are an AI guide describing what's visible in a geospatial 3D view.

Viewing Angle: ${JSON.stringify(viewingAngle)}

Events visible: ${this.events.length}
Patterns: ${viewingAngle.description}

Write a brief, engaging narration (2-3 sentences) about what this view reveals about the geospatial event patterns.
          `,
        },
      ],
    });

    return response.content[0].text;
  }

  async analyzeVisibleEvents() {
    // Get events currently visible in camera frustum
    const visibleEvents = this.getVisibleInFrustum();

    if (visibleEvents.length === 0) return null;

    // Ask Claude to analyze them
    const response = await this.anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `
Analyze these visible events from a 3D terrain perspective:

${JSON.stringify(visibleEvents, null, 2)}

Provide:
1. Key spatial relationships
2. Potential causal factors (terrain influence)
3. Interesting patterns
3. Recommended next investigation angles
          `,
        },
      ],
    });

    return response.content[0].text;
  }

  onCameraMove() {
    // Continuously analyze what's visible
    clearTimeout(this.analysisTimeout);

    this.analysisTimeout = setTimeout(async () => {
      const analysis = await this.analyzeVisibleEvents();
      if (analysis) {
        updateAIInsightsPanel(analysis);
      }
    }, 2000);
  }
}

// Usage
const aiGuide = new AIGuideExplorer(events, tileset, process.env.ANTHROPIC_API_KEY);
await aiGuide.guidedNarrative();

// Or continuous analysis
scene.addEventListener('camera-move', () => aiGuide.onCameraMove());
```

**Best For:** Exploratory analysis, understanding complex geospatial relationships, educational tours

**Performance:** Low (rendering only), high server load (frequent Claude API calls)

---

## Comparative Summary Table

| Strategy | Use Case | Complexity | Performance | User Learning |
|----------|----------|-----------|-------------|---------------|
| 1. Immersive Dive | Deep location analysis | High | Medium | Medium |
| 2. Picture-in-Picture | Context + detail | High | Low | Low |
| 3. Timeline Scrubber | Historical analysis | Very High | Low | High |
| 4. Heatmap Overlay | Pattern discovery | Medium | High | Low |
| 5. AR Spillover | Mobile immersion | Very High | High | High |
| 6. Split Comparison | Before/after studies | High | Low | Low |
| 7. Card Carousel | Story exploration | Medium | High | Low |
| 8. 3D Briefing Panel | Research-oriented | Medium | Medium | Medium |
| 9. Cluster Explosion | Density analysis | Very High | Medium | High |
| 10. AI Guide | Exploratory discovery | High | Low | High |

---

## Recommendation for Earth00

**Best Initial Combination:** Start with **Strategy 1 (Immersive Dive)** + **Strategy 4 (Heatmap Overlay)**
- Immersive dive gives powerful deep-dive capability
- Heatmap overlay helps identify where to dive
- Both leverage existing event data structure
- Moderate implementation complexity
- Can add others incrementally

**For v2:** Add **Strategy 7 (Card Carousel)** for narrative-driven exploration

**For v3:** Consider **Strategy 10 (AI Guide)** to differentiate from other mapping tools
