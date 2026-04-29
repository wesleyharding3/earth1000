/**
 * shareImageGenerator.js — server-side branded share images.
 *
 * Renders a 1200×630 PNG (the standard Open Graph card size that
 * Twitter, iMessage, Discord, Slack, and Facebook all consume cleanly)
 * for three entity types:
 *
 *   • thread   — story_threads.title + primary_nations + importance
 *   • line     — story_timelines.title + primary_nations + thread count
 *   • heatmap  — Map This question + mode + countries painted
 *
 * Stack: SVG built via template literal → @resvg/resvg-js → PNG buffer.
 * Avoids puppeteer (which would balloon the Render deploy by ~120MB
 * for the Chromium download). resvg-js is ~3MB, no native browser, and
 * gives us pixel-perfect deterministic output that's easy to test.
 *
 * Caching: in-process LRU keyed by `${kind}:${id}:${version}`. Set
 * `version` per template change so a content edit (e.g. thread title
 * changes) busts old cache entries naturally. Kept small — generation
 * is cheap (~30-80ms) and OG-card hits are bursty, not constant.
 */

'use strict';

const { Resvg } = require('@resvg/resvg-js');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

// ─── App icon (load once at module init) ──────────────────────────────
// Embed the same icon users see on their iOS Home Screen — the gold
// wireframe globe + italic "e" + comet streak — into every share card.
// Reads from www/apple-touch-icon.png (180×180), encodes as base64
// data URI, splices into the SVG via <image href="data:...">. Falls
// back gracefully if the file isn't there at boot.
let _appIconDataUri = null;
try {
  const iconPath = path.join(__dirname, 'www', 'apple-touch-icon.png');
  const buf = fs.readFileSync(iconPath);
  _appIconDataUri = `data:image/png;base64,${buf.toString('base64')}`;
} catch (err) {
  console.warn('[shareImg] app icon not loaded:', err.message);
}

// ─── Font files (load once if present) ────────────────────────────────
// resvg-js needs explicit font files to render anything other than
// the host OS's default. Render's container has Liberation/DejaVu but
// not the system-ui family our app uses, so without a bundled font
// the headlines render in a typewriter-ish fallback. To get clean
// sans typography on the OG card, drop Inter (or any sans TTF/OTF)
// into a `fonts/` folder at the repo root — files are picked up
// automatically by resvg via fontFiles option below.
const _fontFiles = [];
try {
  const fontsDir = path.join(__dirname, 'fonts');
  if (fs.existsSync(fontsDir)) {
    for (const entry of fs.readdirSync(fontsDir)) {
      if (/\.(ttf|otf)$/i.test(entry)) _fontFiles.push(path.join(fontsDir, entry));
    }
  }
} catch (err) {
  console.warn('[shareImg] font load:', err.message);
}

// ─── Brand tokens ─────────────────────────────────────────────────────
// Match the in-app palette. If we change the brand, only this block.
const BRAND = Object.freeze({
  bgTop:     '#060a14',  // dark navy at top
  bgBot:     '#0d1525',  // slightly lighter at bottom
  gold:      '#d4a843',  // primary accent
  goldSoft:  'rgba(212,168,67,0.55)',
  cream:     '#f4ead2',  // headline text
  ink:       '#ffffff',
  inkMute:   'rgba(255,255,255,0.62)',
  inkDim:    'rgba(255,255,255,0.38)',
  card:      'rgba(255,255,255,0.04)',
  cardLine:  'rgba(255,255,255,0.10)',
  important: '#ff9b3a', // importance pill warm orange
});

// 1200×630 = standard og:image dimensions. Twitter "summary_large_image"
// also accepts 2:1 (1200×600); we pick 1200×630 because Discord renders
// cleaner on it.
const W = 1200;
const H = 630;

// ─── Flag image cache ─────────────────────────────────────────────────
// resvg-js can fetch remote images during render but blocks the event
// loop; explicit pre-fetch + base64 embed is faster and predictable.
// flagcdn returns ~1-3KB PNGs; we cache forever in-process.
const _flagCache = new Map();
// flagcdn ships PNGs at fixed widths only (20/40/80/160/320/640).
// 80 is enough resolution for the 30px chip slot and keeps fetches small.
const FLAG_W = 80;

function _fetchBuf(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // flagcdn occasionally redirects; resolve up to 3 hops.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return _fetchBuf(next, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`flag fetch ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Wider-protocol image fetch — handles BOTH http and https plus
// redirects + an 8s timeout. Used by the hero-image right panel
// since publisher-hosted images come from arbitrary CDNs (some
// behind CloudFront, some on plain http for legacy sites).
const _http = require('http');
function _fetchImageBufAny(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('no url'));
    const lib = url.startsWith('http://') ? _http : https;
    const req = lib.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return _fetchImageBufAny(next, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`hero fetch ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('hero fetch timeout')));
  });
}

// Sniff the image format from the buffer's magic bytes so we can
// build a correct data URI (resvg renders JPEG and PNG natively;
// WebP/GIF best-effort).
function _detectImageMime(buf) {
  if (!buf || buf.length < 4) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  return 'image/jpeg';
}

async function _flagDataUri(iso) {
  const code = String(iso || '').toLowerCase();
  if (!code) return null;
  if (_flagCache.has(code)) return _flagCache.get(code);
  try {
    const buf = await _fetchBuf(`https://flagcdn.com/w${FLAG_W}/${code}.png`);
    const dataUri = `data:image/png;base64,${buf.toString('base64')}`;
    _flagCache.set(code, dataUri);
    return dataUri;
  } catch (err) {
    // On flag-fetch failure, embed nothing — the chip falls back to
    // text-only rendering. Don't blow up the whole image generator.
    _flagCache.set(code, null);
    return null;
  }
}

// ─── SVG helpers ──────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// Wrap text into N lines that fit a max char-width budget. We don't
// have access to actual font metrics in resvg, but the system fonts we
// use are predictable: at 64px, ~22 chars/line is safe for English.
// Roman characters run ~0.55× the size as horizontal width.
function _wrapLines(text, maxChars, maxLines) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (lines.length >= maxLines) break;
    if (!cur.length) { cur = w; continue; }
    if (cur.length + 1 + w.length <= maxChars) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // If we cut off mid-text, append ellipsis to the last line.
  const totalRendered = lines.join(' ').length;
  const totalText = words.join(' ').length;
  if (totalRendered < totalText && lines.length) {
    const last = lines[lines.length - 1];
    const room = Math.max(0, maxChars - last.length - 1);
    if (room > 0) lines[lines.length - 1] = last + '…';
    else lines[lines.length - 1] = last.replace(/\s*\S+$/, '') + '…';
  }
  return lines;
}

// Font-family chain used by every text element in every template.
// Inter is the brand match if a TTF is dropped into `fonts/`; otherwise
// DejaVu Sans is the next best widely-installed Linux sans-serif (on
// the Render container's Debian base). Earlier the chain was
// `-apple-system, system-ui, ...` which exists on macOS/iOS but NOT
// on the Linux server, so resvg-js fell through to its default
// fallback (Liberation Mono on most images) — explaining the blocky
// typewriter look in the original OG cards. Forcing a known-installed
// sans up front fixes the regression.
const FONT_FAMILY = "'Inter', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', sans-serif";

// ─── Common chrome (app icon + footer) ────────────────────────────────
// Single source of truth for the brand mark up top + earth00.com
// footer at the bottom. Renders the actual app icon (same image users
// see on their iOS Home Screen) at 64×64 in the top-left so the OG
// card stays brand-consistent with the in-app snapshot share.
function _chrome() {
  const ICON_SIZE = 64;
  const iconBlock = _appIconDataUri
    ? `<image x="56" y="42" width="${ICON_SIZE}" height="${ICON_SIZE}"
              href="${_appIconDataUri}" preserveAspectRatio="xMidYMid"/>`
    : `
      <!-- Fallback wireframe + e if the bundled icon failed to load. -->
      <g transform="translate(56, 54)">
        <g stroke="${BRAND.gold}" fill="none" stroke-width="1.6" opacity="0.92">
          <ellipse cx="22" cy="22" rx="20" ry="20"/>
          <ellipse cx="22" cy="22" rx="20" ry="8"/>
          <ellipse cx="22" cy="22" rx="8"  ry="20"/>
          <line x1="2"  y1="22" x2="42" y2="22"/>
        </g>
        <text x="22" y="32" text-anchor="middle"
              font-family="Georgia, 'Times New Roman', serif"
              font-style="italic" font-weight="700" font-size="32"
              fill="${BRAND.gold}">e</text>
      </g>
    `;
  return `
    ${iconBlock}
    <!-- Bottom-left: domain footer -->
    <text x="56" y="${H - 44}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="16" letter-spacing="2"
          fill="${BRAND.goldSoft}">EARTH00.COM</text>
  `;
}

// Hero image right-panel — fetches the thread/line's hero image and
// embeds it as a soft-faded right-side panel taking up ~55% of the
// canvas. Tries `heroUrl` first, falls back to `heroCatalogUrl` (the
// catalog/bucket image) on failure. Returns an empty string if both
// fail — caller's left-aligned chrome takes the full canvas in that
// case (graceful degradation rather than empty placeholder boxes).
//
// Visual treatment: cover-fit the image into the right ~55% (so it
// fills the panel, edges may crop), then overlay a left-edge dark-
// to-transparent gradient that fades the image into the left chrome
// zone. The fade prevents a hard vertical seam between hero and
// chrome and lets the title bleed slightly into the hero area
// without losing legibility.
// Hard cap on embedded hero size. Anything above this is skipped and we
// fall through to the next candidate (or empty hero). Some publisher
// CDNs serve 4–8MB JPEGs at full resolution; embedding those as base64
// pushes the SVG past 10MB, and resvg-js on Render's small-tier
// container then either OOMs the native binary or hangs the request
// long enough to trip an upstream timeout — turning every share card
// for that thread into a 500. 1.5MB is enough for ~2K-wide JPEGs at
// reasonable quality (the panel only renders at ~660×630 anyway, so
// extra source resolution is wasted bytes).
const HERO_MAX_BYTES = 1_500_000;

async function _heroPanel(heroUrl, heroCatalogUrl) {
  const candidates = [heroUrl, heroCatalogUrl].filter(s => typeof s === 'string' && s.trim());
  for (const u of candidates) {
    try {
      const buf = await _fetchImageBufAny(u);
      if (!buf || buf.length < 64) continue;
      if (buf.length > HERO_MAX_BYTES) {
        console.warn(`[shareImg] hero image too large (${buf.length} bytes > ${HERO_MAX_BYTES}); skipping ${u.slice(0, 80)}`);
        continue;
      }
      const mime = _detectImageMime(buf);
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
      // Right ~55% of canvas with a 200px left-edge fade zone.
      const heroX     = Math.round(W * 0.45); // 540
      const fadeEndX  = Math.round(W * 0.62); // 744
      const heroW     = W - heroX;
      return `
        <defs>
          <linearGradient id="heroFade" x1="${heroX}" y1="0"
                          x2="${fadeEndX}" y2="0"
                          gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stop-color="${BRAND.bgTop}" stop-opacity="1"/>
            <stop offset="100%" stop-color="${BRAND.bgTop}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <image x="${heroX}" y="0" width="${heroW}" height="${H}"
               href="${dataUri}"
               preserveAspectRatio="xMidYMid slice"
               opacity="0.92"/>
        <rect x="${heroX}" y="0" width="${fadeEndX - heroX}" height="${H}"
              fill="url(#heroFade)"/>
      `;
    } catch (_) {
      // try next candidate
    }
  }
  return '';
}

// Coverage scope line — same format as the in-app snapshot share so
// the two artifacts (server OG card + client snapshot PNG) read as a
// matched pair. Pluralizes correctly. Returns an empty string if any
// of the three counts is missing or zero so the caller can omit the
// row entirely (half-data looks worse than no-data).
function _coverageLine({ articleCount, languageCount, countryCount }) {
  if (!Number.isFinite(articleCount) || articleCount <= 0) return '';
  if (!Number.isFinite(languageCount) || !Number.isFinite(countryCount)) return '';
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const lc = `${fmt(languageCount)} LANGUAGE${languageCount === 1 ? '' : 'S'}`;
  const cc = `${fmt(countryCount)} COUNTR${countryCount === 1 ? 'Y' : 'IES'}`;
  const ac = `${fmt(articleCount)} ARTICLE${articleCount === 1 ? '' : 'S'}`;
  return `COVERAGE IN ${lc} · ${cc} · ${ac}`;
}

function _background() {
  return `
    <defs>
      <linearGradient id="bgGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${BRAND.bgTop}"/>
        <stop offset="100%" stop-color="${BRAND.bgBot}"/>
      </linearGradient>
      <radialGradient id="goldGlow" cx="80%" cy="20%" r="60%">
        <stop offset="0%"  stop-color="${BRAND.gold}" stop-opacity="0.18"/>
        <stop offset="60%" stop-color="${BRAND.gold}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="goldSweep" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%"   stop-color="${BRAND.gold}" stop-opacity="0"/>
        <stop offset="50%"  stop-color="${BRAND.gold}" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="${BRAND.gold}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGradient)"/>
    <rect width="${W}" height="${H}" fill="url(#goldGlow)"/>
    <!-- Subtle horizontal accent line under the top chrome -->
    <rect x="0" y="120" width="${W}" height="1.2" fill="url(#goldSweep)" opacity="0.6"/>
  `;
}

// Render a row of country flag chips at a given y position.
// Returns SVG markup (string). isos[] should be uppercased ISO 3166-1 alpha-2.
async function _flagChips(isos, x, y) {
  const list = (isos || []).slice(0, 6); // hard cap on chips per image
  const CHIP_H = 36;
  const FLAG_W_INNER = 30;
  const FLAG_H_INNER = 22;
  const PAD = 12;
  const GAP = 10;
  const fragments = [];
  let cx = x;
  for (const iso of list) {
    const dataUri = await _flagDataUri(iso);
    const labelW = 28; // approx width of 2-3 char label
    const chipW = PAD + FLAG_W_INNER + 8 + labelW + PAD;
    fragments.push(`
      <g transform="translate(${cx}, ${y})">
        <rect width="${chipW}" height="${CHIP_H}" rx="${CHIP_H/2}"
              fill="${BRAND.card}" stroke="${BRAND.cardLine}" stroke-width="1"/>
        ${dataUri ? `<image x="${PAD}" y="${(CHIP_H - FLAG_H_INNER) / 2}"
                            width="${FLAG_W_INNER}" height="${FLAG_H_INNER}"
                            href="${dataUri}" preserveAspectRatio="xMidYMid slice"/>` : ''}
        <text x="${PAD + FLAG_W_INNER + 8}" y="${CHIP_H/2 + 5}"
              font-family="${FONT_FAMILY}"
              font-weight="700" font-size="14" letter-spacing="1"
              fill="${BRAND.cream}">${_esc(iso)}</text>
      </g>
    `);
    cx += chipW + GAP;
  }
  return fragments.join('\n');
}

function _importanceBadge(score, x, y) {
  if (score == null) return '';
  const v = Math.max(0, Math.min(10, Number(score)));
  const label = v >= 8 ? 'CRITICAL' : v >= 6 ? 'IMPORTANT' : 'TRACKING';
  const color = v >= 8 ? BRAND.important : v >= 6 ? BRAND.gold : BRAND.inkDim;
  return `
    <g transform="translate(${x}, ${y})">
      <rect width="170" height="36" rx="18"
            fill="rgba(255,155,58,0.10)" stroke="${color}" stroke-width="1.4"/>
      <text x="85" y="24" text-anchor="middle"
            font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
            font-weight="800" font-size="13" letter-spacing="0.18em"
            fill="${color}">${label}</text>
    </g>
  `;
}

// ─── Templates per entity type ────────────────────────────────────────

async function _renderThreadSvg({ title, isos, category, articleCount, languageCount, countryCount, heroImageUrl, heroCatalogImageUrl }) {
  // Hero image right-panel (async — may fetch a remote CDN image).
  // Fetched once per CDN cache miss; subsequent share-image requests
  // for the same thread come from the in-process LRU below.
  const heroSvg = await _heroPanel(heroImageUrl, heroCatalogImageUrl);
  const hasHero = !!heroSvg;

  // Title wraps tighter (22 chars × 3 lines, 56px) when a hero panel
  // is present so the headline doesn't crash into the hero panel's
  // fade zone. Without a hero, the title can use the wider 28-char
  // wrap at 62px (the original layout).
  const lines = hasHero
    ? _wrapLines(title || 'Untitled story', 22, 3)
    : _wrapLines(title || 'Untitled story', 28, 3);
  const titleSize = hasHero ? 56 : 62;
  const titleLineH = hasHero ? 70 : 78;
  const titleSvg = lines.map((line, i) => {
    const y = 240 + i * titleLineH;
    return `<text x="56" y="${y}"
                  font-family="${FONT_FAMILY}"
                  font-weight="700" font-size="${titleSize}" letter-spacing="-1.5"
                  fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  const chipsY = H - 140;
  const coverageText = _coverageLine({ articleCount, languageCount, countryCount });
  const coverageSvg = coverageText ? `
    <text x="56" y="${chipsY - 18}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="13" letter-spacing="2"
          fill="rgba(255,255,255,0.62)">${_esc(coverageText)}</text>
  ` : '';
  const chipsSvg = await _flagChips(isos, 56, chipsY);

  const catLabel = (category || 'Story').toUpperCase();
  const catSvg = `
    <text x="56" y="180"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="13" letter-spacing="3"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY THREAD</text>
  `;

  // Layer order: bg → hero panel → chrome (logo/footer) → category
  // → title → coverage → chips. Hero sits BELOW chrome so the icon
  // and footer text always read on the dark background, not on the
  // hero image.
  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${heroSvg}
      ${_chrome()}
      ${catSvg}
      ${titleSvg}
      ${coverageSvg}
      ${chipsSvg}
    </svg>
  `;
}

async function _renderLineSvg({ title, isos, category, articleCount, languageCount, countryCount, heroImageUrl, heroCatalogImageUrl }) {
  const heroSvg = await _heroPanel(heroImageUrl, heroCatalogImageUrl);
  const hasHero = !!heroSvg;

  const lines = hasHero
    ? _wrapLines(title || 'Untitled timeline', 22, 3)
    : _wrapLines(title || 'Untitled timeline', 28, 3);
  const titleSize = hasHero ? 56 : 62;
  const titleLineH = hasHero ? 70 : 78;
  const titleSvg = lines.map((line, i) => {
    const y = 240 + i * titleLineH;
    return `<text x="56" y="${y}"
                  font-family="${FONT_FAMILY}"
                  font-weight="700" font-size="${titleSize}" letter-spacing="-1.5"
                  fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  const chipsY = H - 140;
  const coverageText = _coverageLine({ articleCount, languageCount, countryCount });
  const coverageSvg = coverageText ? `
    <text x="56" y="${chipsY - 18}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="13" letter-spacing="2"
          fill="rgba(255,255,255,0.62)">${_esc(coverageText)}</text>
  ` : '';
  const chipsSvg = await _flagChips(isos, 56, chipsY);

  const catLabel = (category || 'Story').toUpperCase();
  const catSvg = `
    <text x="56" y="180"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="13" letter-spacing="3"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY LINE</text>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${heroSvg}
      ${_chrome()}
      ${catSvg}
      ${titleSvg}
      ${coverageSvg}
      ${chipsSvg}
    </svg>
  `;
}

// ─── Flows template ──────────────────────────────────────────────────
// Shareable News Flows poster. Two visual modes:
//   • aggregate  — top arcs over the entire selected window, all rendered
//   • timeseries — peak-frame: arcs active on/around the day with the
//                  highest activity in the window, with a "▶ REPLAY"
//                  badge so the still hints that the link plays motion
//
// Map projection is equirectangular cropped to ±60° latitude. Arcs are
// quadratic Béziers with a control point pulled "outward" so longer
// flows curve more visibly. No coastline outlines — keeps the brand
// dependency-free; the gold arcs against the dark background read as a
// stylized abstraction of global movement, not a literal globe.
function _projectLonLat(lon, lat, mapBox) {
  // mapBox = { x, y, w, h } — the rectangle inside the SVG where the
  // equirectangular map lives. Lat clipped to ±60 to keep poles out of
  // the frame (arcs near them are rare in news flows anyway).
  const clampedLat = Math.max(-60, Math.min(60, Number(lat) || 0));
  const lng = Number(lon) || 0;
  const x = mapBox.x + ((lng + 180) / 360) * mapBox.w;
  const y = mapBox.y + ((60 - clampedLat) / 120) * mapBox.h;
  return { x, y };
}

function _arcPath(p1, p2) {
  // Quadratic Bézier with a control point lifted perpendicular to the
  // chord. Lift = chord-length / 4, capped, sign chosen to bow upward
  // when both endpoints are in the lower half (otherwise downward).
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  const lift = Math.min(110, chord / 4);
  // Bow upward (towards top of canvas, lower y) for visual lift.
  const cpX = midX;
  const cpY = midY - lift;
  return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${cpX.toFixed(1)},${cpY.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
}

async function _renderFlowsSvg({ title, mode, dateLabel, peakLabel, arcs, topPlaces }) {
  const isPeak = mode === 'timeseries';
  // Map area — leaves 130px at top for title strip, ~100px at bottom for
  // chips/footer.
  const MAP = { x: 56, y: 150, w: W - 112, h: 360 };

  // Sort arcs by weight (desc) so heavier arcs render on top of lighter
  // ones, then cap at 40 to avoid muddying the image.
  const sorted = (Array.isArray(arcs) ? arcs : [])
    .slice()
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, 40);

  const maxWeight = Math.max(1, ...sorted.map(a => Number(a.weight) || 0));

  // Render arcs back-to-front with weight-scaled stroke + opacity. The
  // chunkiest flows pop, the lighter ones fade toward decorative noise.
  const arcSvg = sorted.map((a, i) => {
    const p1 = _projectLonLat(a.srcLon, a.srcLat, MAP);
    const p2 = _projectLonLat(a.dstLon, a.dstLat, MAP);
    const w  = Number(a.weight) || 0;
    const norm = w / maxWeight;
    const stroke = 1.2 + norm * 2.8;            // 1.2 → 4.0
    const opacity = 0.25 + norm * 0.65;         // 0.25 → 0.9
    return `<path d="${_arcPath(p1, p2)}"
              fill="none" stroke="${BRAND.gold}"
              stroke-width="${stroke.toFixed(2)}"
              stroke-linecap="round"
              opacity="${opacity.toFixed(2)}"/>
            <circle cx="${p1.x.toFixed(1)}" cy="${p1.y.toFixed(1)}" r="${(1.5 + norm * 1.5).toFixed(1)}"
                    fill="${BRAND.cream}" opacity="${(0.6 + norm * 0.4).toFixed(2)}"/>
            <circle cx="${p2.x.toFixed(1)}" cy="${p2.y.toFixed(1)}" r="${(1.5 + norm * 1.5).toFixed(1)}"
                    fill="${BRAND.gold}" opacity="${(0.7 + norm * 0.3).toFixed(2)}"/>`;
  }).join('\n');

  // Title (theme/keyword/category) — falls back to "Global Story Flows"
  // when no theme is supplied (the user shared the default unfiltered view).
  const titleText = (title || 'Global Story Flows').slice(0, 80);
  const titleLines = _wrapLines(titleText, 36, 2);
  const titleSvg = titleLines.map((line, i) => {
    const y = 90 + i * 46;
    return `<text x="56" y="${y}"
              font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
              font-weight="800" font-size="40" letter-spacing="-0.6"
              fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  // Mode badge (top-right) — "AGGREGATE · 2.4K ROUTES" or
  // "PEAK · MAR 14, 2026". Carries the most context the recipient
  // needs to grok the still vs. the link's motion replay.
  const badgeText = (isPeak ? (peakLabel || 'PEAK FRAME') : 'AGGREGATE').toUpperCase();
  const badgeColor = isPeak ? BRAND.important : BRAND.gold;
  const badgeBg = isPeak ? 'rgba(255,155,58,0.10)' : 'rgba(212,168,67,0.10)';
  const badgeWidth = Math.max(180, badgeText.length * 11 + 36);
  const badgeSvg = `
    <g transform="translate(${W - 56 - badgeWidth}, 60)">
      <rect width="${badgeWidth}" height="36" rx="18"
            fill="${badgeBg}" stroke="${badgeColor}" stroke-width="1.4"/>
      <text x="${badgeWidth / 2}" y="24" text-anchor="middle"
            font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
            font-weight="800" font-size="13" letter-spacing="0.18em"
            fill="${badgeColor}">${_esc(badgeText)}</text>
    </g>
  `;

  // Date range subtitle below the title (e.g. "MAR 1 – APR 15, 2026 · NEWS FLOWS").
  const dateRow = (dateLabel || 'NEWS FLOWS').toUpperCase();
  const dateRowSvg = `
    <text x="56" y="180"
          font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
          font-weight="700" font-size="13" letter-spacing="0.22em"
          fill="${BRAND.gold}">${_esc(dateRow)}</text>
  `;

  // Top-place chips at the bottom: 3 origins + 3 destinations (or fewer)
  // so the recipient can read which places dominate the flow even
  // before tapping through.
  const chipsY = H - 100;
  const chipIsos = (Array.isArray(topPlaces) ? topPlaces : [])
    .filter(Boolean)
    .map(p => String(p).toUpperCase())
    .slice(0, 6);
  const chipsSvg = await _flagChips(chipIsos, 56, chipsY);

  // Replay badge (timeseries only, bottom-right) — tiny play-glyph pill
  // that hints "this still has motion behind it; tap to replay".
  const replaySvg = isPeak ? `
    <g transform="translate(${W - 220}, ${chipsY + 4})">
      <rect width="164" height="32" rx="16"
            fill="rgba(255,155,58,0.10)"
            stroke="${BRAND.important}" stroke-width="1.4"/>
      <polygon points="20,11 20,22 30,16.5"
               fill="${BRAND.important}"/>
      <text x="40" y="22"
            font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
            font-weight="800" font-size="11" letter-spacing="0.18em"
            fill="${BRAND.important}">REPLAY ON EARTH00</text>
    </g>
  ` : '';

  // Subtle equator + prime-meridian guidelines so the projection reads
  // as a map, not a random scatter. 0.06 opacity keeps them whisper-faint.
  const eq  = _projectLonLat(0, 0, MAP);
  const pm  = _projectLonLat(0, 60, MAP);
  const pmEnd = _projectLonLat(0, -60, MAP);
  const guidesSvg = `
    <line x1="${MAP.x}" y1="${eq.y.toFixed(1)}"
          x2="${MAP.x + MAP.w}" y2="${eq.y.toFixed(1)}"
          stroke="${BRAND.cardLine}" stroke-width="1" stroke-dasharray="3 5" opacity="0.5"/>
    <line x1="${pm.x.toFixed(1)}" y1="${pm.y.toFixed(1)}"
          x2="${pmEnd.x.toFixed(1)}" y2="${pmEnd.y.toFixed(1)}"
          stroke="${BRAND.cardLine}" stroke-width="1" stroke-dasharray="3 5" opacity="0.5"/>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${_chrome()}
      ${dateRowSvg}
      ${titleSvg}
      ${badgeSvg}
      ${guidesSvg}
      ${arcSvg}
      ${chipsSvg}
      ${replaySvg}
    </svg>
  `;
}

async function _renderHeatmapSvg({ question, mode, countriesCount, topIsos }) {
  const lines = _wrapLines(question || 'Untitled view', 30, 4);
  const titleSvg = lines.map((line, i) => {
    const y = 230 + i * 68;
    return `<text x="56" y="${y}"
                  font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
                  font-weight="800" font-size="54" letter-spacing="-1"
                  fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  const chipsY = H - 140;
  const chipsSvg = await _flagChips(topIsos, 56, chipsY);

  const sub = `MAP THIS · ${(mode || 'percent').toUpperCase()} · ${countriesCount || 0} COUNTRIES`;
  const subSvg = `
    <text x="56" y="180"
          font-family="-apple-system, system-ui, 'Segoe UI', sans-serif"
          font-weight="700" font-size="13" letter-spacing="0.22em"
          fill="${BRAND.gold}">${_esc(sub)}</text>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${_chrome()}
      ${subSvg}
      ${titleSvg}
      ${chipsSvg}
    </svg>
  `;
}

// ─── Public render → PNG buffer ───────────────────────────────────────
async function _toPng(svg) {
  const resvg = new Resvg(svg, {
    background: BRAND.bgTop,
    fitTo: { mode: 'width', value: W },
    font: {
      // Load any TTF/OTF dropped into ./fonts/ (Inter is the brand
      // match — see top of file). System fonts as backup so DejaVu
      // Sans / Liberation Sans are still found if no bundle is present.
      loadSystemFonts: true,
      ...(_fontFiles.length ? { fontFiles: _fontFiles } : {}),
    },
  });
  return resvg.render().asPng();
}

// In-process LRU cache for rendered PNGs.
const _imageCache = new Map();
const IMAGE_CACHE_MAX = 64; // small — these are 1200×630 PNGs (~80-150KB each)

function _cacheGet(key) {
  if (!_imageCache.has(key)) return null;
  // touch (LRU)
  const v = _imageCache.get(key);
  _imageCache.delete(key);
  _imageCache.set(key, v);
  return v;
}

function _cacheSet(key, png) {
  _imageCache.set(key, png);
  while (_imageCache.size > IMAGE_CACHE_MAX) {
    const oldestKey = _imageCache.keys().next().value;
    _imageCache.delete(oldestKey);
  }
}

/**
 * @param {Object} entity — { kind: 'thread'|'line'|'heatmap', cacheKey: string, ...data }
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generate(entity) {
  const cacheKey = entity.cacheKey || `${entity.kind}:${JSON.stringify(entity)}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  let svg;
  switch (entity.kind) {
    case 'thread':  svg = await _renderThreadSvg(entity);  break;
    case 'line':    svg = await _renderLineSvg(entity);    break;
    case 'heatmap': svg = await _renderHeatmapSvg(entity); break;
    case 'flows':   svg = await _renderFlowsSvg(entity);   break;
    default:        throw new Error(`unknown share kind: ${entity.kind}`);
  }
  const png = await _toPng(svg);
  _cacheSet(cacheKey, png);
  return png;
}

// Bust a single cache entry — useful when the underlying entity changes
// (e.g. an admin retitles a thread). The server endpoints can compute
// the same key and call this from the relevant write paths.
function bustCache(cacheKey) {
  _imageCache.delete(cacheKey);
}

module.exports = { generate, bustCache, BRAND, W, H };
