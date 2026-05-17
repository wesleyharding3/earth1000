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
  // share-icon-circle.png is a pre-masked copy of apple-touch-icon.png
  // with the iOS-style rounded-rect corners alpha-cut to a true circle.
  // The original apple-touch-icon.png stays untouched for the iOS home
  // screen (which re-masks it to iOS's own squircle anyway); the
  // carousel cards use the circle-masked variant so the visible edge
  // reads as a clean circle against the dark card bg instead of the
  // awkward rounded-rect "nonagon" silhouette.
  const iconPath = path.join(__dirname, 'www', 'share-icon-circle.png');
  const buf = fs.readFileSync(iconPath);
  _appIconDataUri = `data:image/png;base64,${buf.toString('base64')}`;
} catch (err) {
  // Fall back to the iOS-tagged original if the masked variant isn't on disk.
  try {
    const fallback = path.join(__dirname, 'www', 'apple-touch-icon.png');
    const buf = fs.readFileSync(fallback);
    _appIconDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    console.warn('[shareImg] using unmasked apple-touch-icon.png (share-icon-circle.png missing)');
  } catch (err2) {
    console.warn('[shareImg] app icon not loaded:', err2.message);
  }
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
    <!-- Bottom-left: domain footer. Bumped from 16px → 22px so the
         wordmark reads as a real brand element rather than fine print
         when the card is shown at thumbnail sizes in iMessage / Twitter
         / Discord previews. -->
    <text x="56" y="${H - 38}"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="22" letter-spacing="2"
          fill="${BRAND.goldSoft}">earth00.com</text>
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
  // Sizing bumped from 36px chip / 30×22 flag / 14px text →
  // 50px chip / 42×30 flag / 18px text so the chip row reads as a
  // first-class element next to the title rather than a footnote.
  // Larger chips also leave the OG card looking less empty now that
  // the right-panel hero image has been removed.
  const CHIP_H = 50;
  const FLAG_W_INNER = 42;
  const FLAG_H_INNER = 30;
  const PAD = 16;
  const GAP = 12;
  const fragments = [];
  let cx = x;
  for (const iso of list) {
    const dataUri = await _flagDataUri(iso);
    const labelW = 36; // approx width of 2-3 char label at 18px
    const chipW = PAD + FLAG_W_INNER + 10 + labelW + PAD;
    fragments.push(`
      <g transform="translate(${cx}, ${y})">
        <rect width="${chipW}" height="${CHIP_H}" rx="${CHIP_H/2}"
              fill="${BRAND.card}" stroke="${BRAND.cardLine}" stroke-width="1"/>
        ${dataUri ? `<image x="${PAD}" y="${(CHIP_H - FLAG_H_INNER) / 2}"
                            width="${FLAG_W_INNER}" height="${FLAG_H_INNER}"
                            href="${dataUri}" preserveAspectRatio="xMidYMid slice"/>` : ''}
        <text x="${PAD + FLAG_W_INNER + 10}" y="${CHIP_H/2 + 6}"
              font-family="${FONT_FAMILY}"
              font-weight="700" font-size="18" letter-spacing="1"
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

// Build the summary SVG block. `description` truncates to 220 chars
// with ellipsis; wrapped to fit the left chrome zone (wider if no
// hero, narrower if a hero panel occupies the right 55%). Three lines
// max — gives the reader a real elevator pitch, not a stub.
function _summarySvg({ description, hasHero, y }) {
  if (!description || typeof description !== 'string') return '';
  const trimmed = description.trim();
  if (!trimmed) return '';
  const capped = trimmed.length > 220
    ? trimmed.slice(0, 217).replace(/\s+\S*$/, '') + '…'
    : trimmed;
  // Wrap width matches the title's chars-per-line so the two blocks
  // share a visual rhythm. Wider zone without a hero panel.
  const wrapWidth = hasHero ? 36 : 50;
  const lines = _wrapLines(capped, wrapWidth, 3);
  const fontSize = 19;
  const lineH = 26;
  return lines.map((line, i) => `
    <text x="56" y="${y + i * lineH}"
          font-family="${FONT_FAMILY}"
          font-weight="500" font-size="${fontSize}" letter-spacing="-0.2"
          fill="rgba(255,255,255,0.78)">${_esc(line)}</text>
  `).join('\n');
}

async function _renderThreadSvg({ title, description, isos, category, articleCount, languageCount, countryCount, heroImageUrl, heroCatalogImageUrl }) {
  // Hero image right-panel (async — may fetch a remote CDN image).
  // Fetched once per CDN cache miss; subsequent share-image requests
  // for the same thread come from the in-process LRU below.
  const heroSvg = await _heroPanel(heroImageUrl, heroCatalogImageUrl);
  const hasHero = !!heroSvg;

  // Title 2 lines max. Summary block (3 lines, tighter font) lives below.
  // Constraint: title + summary + coverage + chips must all fit above
  // the brand footer at H-38.
  const lines = hasHero
    ? _wrapLines(title || 'Untitled story', 24, 2)
    : _wrapLines(title || 'Untitled story', 32, 2);
  const titleSize = hasHero ? 48 : 54;
  const titleLineH = hasHero ? 60 : 66;
  const titleSvg = lines.map((line, i) => {
    const y = 240 + i * titleLineH;
    return `<text x="56" y="${y}"
                  font-family="${FONT_FAMILY}"
                  font-weight="800" font-size="${titleSize}" letter-spacing="-2"
                  fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  // Summary block sits 28px below the title's last visible baseline.
  const titleBottomY = 240 + (lines.length - 1) * titleLineH;
  const summarySvg = _summarySvg({ description, hasHero, y: titleBottomY + 28 });

  // Chips at H-130 — original position, well above the brand footer at H-38.
  const chipsY = H - 130;
  const coverageText = _coverageLine({ articleCount, languageCount, countryCount });
  // Coverage font bumped to 20px (was 18) to match the upgraded
  // summary + footer typography. Letter-spacing kept at 1.4 for
  // legibility at the larger size.
  const coverageSvg = coverageText ? `
    <text x="56" y="${chipsY - 22}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="20" letter-spacing="1.4"
          fill="rgba(255,255,255,0.72)">${_esc(coverageText)}</text>
  ` : '';
  const chipsSvg = await _flagChips(isos, 56, chipsY);

  const catLabel = (category || 'Story').toUpperCase();
  // Category eyebrow bumped 13px → 19px so it reads at thumbnail size
  // (iMessage / Twitter timeline previews shrink the card to ~600px
  // wide where 13px text disappears entirely).
  const catSvg = `
    <text x="56" y="180"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="19" letter-spacing="3"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY THREAD</text>
  `;

  // Layer order: bg → hero panel → chrome (logo/footer) → category
  // → title → summary → coverage → chips. Hero sits BELOW chrome so
  // the icon and footer text always read on the dark background, not
  // on the hero image. Summary sits above coverage/chips so the
  // reader's eye flows title → summary → stats → flags.
  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${heroSvg}
      ${_chrome()}
      ${catSvg}
      ${titleSvg}
      ${summarySvg}
      ${coverageSvg}
      ${chipsSvg}
    </svg>
  `;
}

// ─── Portrait variant (1080×1350) ─────────────────────────────────────
// Used for the Instagram CAROUSEL where image + video share the same
// 4:5 aspect. The default 1200×630 landscape template doesn't carry
// over cleanly to portrait — there's a lot of empty vertical space
// and the title/description proportions feel cramped. This template
// is built natively for 4:5 with bigger fonts and a description block
// that uses the extra real estate.
const W_P = 1080;
const H_P = 1350;
const PAD_P = 64;

// ─── Animation helpers ────────────────────────────────────────────────
// All animated templates accept an `animation = { progress: 0..1 }`
// parameter. When undefined or progress >= 1, the rendered SVG is the
// final still state (so the same template doubles as the still-image
// generator). When progress is between 0 and 1, per-element opacity,
// clip-paths, and counter values reflect that timeline position. The
// frame loop in animatedCardRenderer.js calls these N times across
// progress = 0..1 to build an MP4 frame sequence.

function _clamp(v, min = 0, max = 1) {
  return v < min ? min : v > max ? max : v;
}
function _easeOutCubic(t) {
  const x = _clamp(t);
  return 1 - Math.pow(1 - x, 3);
}
function _easeInOutCubic(t) {
  const x = _clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
// Given a global progress (0..1) and a window [start, end], return how
// far into THAT window we are (0..1, clamped). Used to drive per-element
// fades that occupy a slice of the overall timeline.
function _windowed(progress, start, end) {
  if (progress <= start) return 0;
  if (progress >= end)   return 1;
  return (progress - start) / (end - start);
}

// Auto-shrink title: try successively smaller font sizes until the
// title fits in maxLines without triggering ellipsis. Returns
// { size, lineH, lines }. Calibrated empirically against Inter @ weight 800.
function _fitTitle(text, sizes) {
  for (const opt of sizes) {
    const lines = _wrapLines(text, opt.charsPerLine, opt.maxLines);
    const lastHasEllipsis = lines.length && lines[lines.length - 1].endsWith('…');
    if (!lastHasEllipsis) return { size: opt.size, lineH: opt.lineH, lines };
  }
  const last = sizes[sizes.length - 1];
  const lines = _wrapLines(text, last.charsPerLine, last.maxLines);
  return { size: last.size, lineH: last.lineH, lines };
}

// ─── Vertical scan-line pass ────────────────────────────────────────
// A 60px-tall gold-gradient band that moves top→bottom across the
// whole card once during a "settled" window of the clip — reads as
// a soft CRT/scanner sweep. Same effect originally built into slide
// 1 (portrait), extracted here for slides 3 + 4 too so all three
// cards share the unified moving-line accent.
//
// `p`              — global progress 0..1
// `windowStart/End`— optional override of the [0.50, 0.85] default
//                    pass window
function _renderScanLine({ p, windowStart = 0.50, windowEnd = 0.85 }) {
  const w = _windowed(p, windowStart, windowEnd);
  if (w <= 0 || w >= 1) return '';
  const scanY = w * H_P;
  return `
    <defs>
      <linearGradient id="scanGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0"   stop-color="${BRAND.gold}" stop-opacity="0"/>
        <stop offset="0.5" stop-color="${BRAND.gold}" stop-opacity="0.18"/>
        <stop offset="1"   stop-color="${BRAND.gold}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${scanY - 30}" width="${W_P}" height="60" fill="url(#scanGrad)"/>
    <rect x="0" y="${scanY - 0.5}" width="${W_P}" height="1" fill="${BRAND.gold}" opacity="0.45"/>
  `;
}

// ─── Border-trace comet ─────────────────────────────────────────────
// Thin gold dim outline around the 1080×1350 perimeter + a brighter
// "comet" segment of dashed stroke that travels clockwise once per
// clip. Same effect originally built into slide 1 (portrait card),
// extracted here so slides 3 + 4 can use it too — gives the whole
// carousel a unified moving-edge accent.
//
// `p` is global progress (0..1). Trace travels clockwise during
// p=[0.08, 0.88], fades in over [0.08, 0.18] and fades out over
// [0.85, 0.97].
function _renderBorderTrace({ p, inset = 28, rx = 22 }) {
  const x = inset;
  const y = inset;
  const w = W_P - inset * 2;
  const h = H_P - inset * 2;
  // Perimeter of a rounded rect ≈ straight runs + corner arcs.
  const perim  = 2 * (w + h) - 8 * rx + 2 * Math.PI * rx;
  const segLen = 110;
  const traceP = _easeOutCubic(_windowed(p, 0.08, 0.88));
  const offset = -(traceP * perim);
  const cometOpacity = _easeOutCubic(_windowed(p, 0.08, 0.18)) *
                       _easeOutCubic(_clamp(1 - (p - 0.85) / 0.12, 0, 1));
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"
          fill="none" stroke="${BRAND.gold}" stroke-width="1" opacity="0.10"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"
          fill="none" stroke="${BRAND.gold}" stroke-width="2"
          stroke-dasharray="${segLen} ${perim - segLen}"
          stroke-dashoffset="${offset.toFixed(1)}"
          opacity="${cometOpacity.toFixed(3)}"/>
  `;
}

// ─── Logo halo ──────────────────────────────────────────────────────
// Pulsing gold radial gradient centered behind the app-icon logo.
// Reusable across all carousel cards (portrait, pie, articles) so the
// brand mark reads consistently — soft gold breathing motion sitting
// behind the icon, with the icon itself rock-steady on top.
//
// `p` is the global animation progress (0..1). `frequency` controls
// pulses per clip (default 2 = inhale-exhale-inhale-exhale over 3s).
function _renderLogoHalo({ cx, cy, size, p = 1, frequency = 2 }) {
  const phase = (Math.sin(p * Math.PI * 2 * frequency) + 1) / 2; // 0..1..0
  const r     = size / 2 + 30 + phase * 18;
  const op    = 0.18 + phase * 0.22;
  // Unique gradient id per call site so multiple halos on the same SVG
  // don't shadow each other.
  const gid = `logoHalo${Math.floor(cx)}_${Math.floor(cy)}`;
  return `
    <defs>
      <radialGradient id="${gid}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">
        <stop offset="0.55" stop-color="${BRAND.gold}" stop-opacity="${op.toFixed(3)}"/>
        <stop offset="1"    stop-color="${BRAND.gold}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${gid})"/>
  `;
}

// ─── App-icon logo (with circular badge) ───────────────────────────
// Renders the actual apple-touch-icon.png — same beautiful artwork
// users see on their iOS Home Screen (proper italic "e", real comet
// streak with tail, polished wireframe globe). The icon's PNG ships
// at 180×180 with a soft-edged squircle silhouette that reads as a
// "weird nonagon" on the dark card bg.
//
// To force a clean circular boundary we layer three primitives:
//   1. A solid black circle behind it (so any transparent corners
//      of the squircle get filled with black inside the boundary)
//   2. The PNG image clipped to the same circle (visible content
//      only inside)
//   3. A thin gold rim ring on top (makes the circular silhouette
//      unambiguous against the dark card bg)
//
// All previously-iterated attempts (raw PNG, mask-clip-only,
// alpha-baked variant, inline SVG redraw of e+globe) failed because
// either (a) the squircle silhouette stayed visible, or (b) my
// SVG-redrawn e looked wrong vs. the proper Georgia italic in the
// real PNG. This combined approach keeps the original art + makes
// the boundary a true circle.
function _renderInlineLogo({ cx, cy, size, scale = 1, opacity = 1 }) {
  const x = cx - size / 2;
  const y = cy - size / 2;
  const r = size / 2;
  const clipId = `logoClipR${Math.floor(cx)}_${Math.floor(cy)}`;
  if (_appIconDataUri) {
    return `
      <defs>
        <clipPath id="${clipId}">
          <circle cx="${cx}" cy="${cy}" r="${r}"/>
        </clipPath>
      </defs>
      <!-- 1. Solid black circle bg — fills any transparent gaps in the
           icon (the squircle's outer edge softens to alpha=0, this
           backstops it so the visible boundary is the circle, not the
           squircle's softer edge). -->
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#000000" opacity="${opacity.toFixed(3)}"/>
      <!-- 2. The real app icon, clipped to the same circle. -->
      <image x="${x}" y="${y}" width="${size}" height="${size}"
             clip-path="url(#${clipId})"
             href="${_appIconDataUri}"
             preserveAspectRatio="xMidYMid meet"
             opacity="${opacity.toFixed(3)}"/>
      <!-- 3. Gold rim ring — makes the circular silhouette obvious
           against the dark-navy card background. Stroke sits exactly
           on the circle perimeter. -->
      <circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="none"
              stroke="${BRAND.gold}" stroke-width="2" opacity="0.7"/>
    `;
  }
  // Cold-start fallback (PNG didn't load): plain gold circle with
  // a centered "e" so the slot isn't a hole.
  return `
    <g opacity="${opacity.toFixed(3)}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${BRAND.gold}"/>
      <text x="${cx}" y="${cy + size * 0.18}" text-anchor="middle"
            font-family="${FONT_FAMILY}" font-weight="900" font-size="${size * 0.6}"
            fill="${BRAND.bgTop}">e</text>
    </g>
  `;
}

async function _renderThreadPortraitSvg({ title, description, isos, category, articleCount, languageCount, countryCount, animation }) {
  // Animation state. `progress` 0..1 drives every dynamic element.
  // Treat undefined / >=1 as the static final frame.
  const p = animation ? _clamp(animation.progress, 0, 1) : 1;
  // Front-loaded timeline so the brand + title are already visible
  // within the first ~0.3s — viewers who scroll within 1.5s still get
  // the hook. Chrome is always-on (no fade); the timing windows pack
  // into the first 2/3 of the clip so the final third reads as a
  // settled, readable still.
  //   chrome:           always on
  //   title:            0.00 → 0.35  (per-line wipe)
  //   description:      0.30 → 0.60
  //   chips slide-in:   0.55 → 0.85
  //   coverage fade:    0.70 → 0.85
  const chromeP   = 1;
  const titleP    = _windowed(p, 0.00, 0.35);
  const descP     = _windowed(p, 0.30, 0.60);
  const chipsP    = _windowed(p, 0.55, 0.85);
  const coverageP = _easeOutCubic(_windowed(p, 0.70, 0.85));

  // ── Title: auto-shrink to avoid ellipsis; per-line clip-path wipe ──
  const titleFit = _fitTitle(title || 'Untitled story', [
    { size: 68, lineH: 80, charsPerLine: 24, maxLines: 3 },
    { size: 60, lineH: 72, charsPerLine: 27, maxLines: 4 },
    { size: 54, lineH: 64, charsPerLine: 30, maxLines: 5 },
    { size: 48, lineH: 58, charsPerLine: 34, maxLines: 5 },
  ]);
  const titleLines  = titleFit.lines;
  const titleSize   = titleFit.size;
  const titleLineH  = titleFit.lineH;
  const titleStartY = 320;

  // Title animation: each line wipes in left-to-right via a clipPath
  // whose width grows from 0 → full. Slowed from 0.18 → 0.55 so the
  // typing motion actually reads as "appearing" rather than popping in
  // instantly — at the old speed a 3-line title was fully visible by
  // t≈0.36s, fast enough that viewers perceived it as "frame 0 blank,
  // frame 1 done" with no in-between motion.
  const titleLineDuration = 0.55;             // each line's wipe duration (in titleP-space 0..1)
  const titleLineStagger  = 0.18;             // stagger between lines
  const titleSvgFragments = titleLines.map((line, i) => {
    const localStart = i * titleLineStagger;
    const localEnd   = localStart + titleLineDuration;
    const lp = _easeOutCubic(_windowed(titleP, localStart, localEnd));
    const y = titleStartY + i * titleLineH;
    const clipId = `titleClip${i}`;
    // Clip rectangle grows from x=PAD_P to x=PAD_P + W_P * lp (covers full width).
    const clipW = (W_P - PAD_P * 2) * lp + 4;
    return `
      <defs>
        <clipPath id="${clipId}">
          <rect x="${PAD_P - 4}" y="${y - titleSize}" width="${clipW}" height="${titleSize + 20}"/>
        </clipPath>
      </defs>
      <text x="${PAD_P}" y="${y}"
            clip-path="url(#${clipId})"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="${titleSize}" letter-spacing="-2"
            fill="${BRAND.cream}">${_esc(line)}</text>
    `;
  });
  // Subtle "cursor" — a thin gold bar that follows the wipe edge of
  // the currently-animating line. Drops off the final still frame.
  if (p < 0.55 && p > 0.05) {
    // find the actively-animating line
    let activeLine = 0;
    for (let i = 0; i < titleLines.length; i++) {
      const localStart = i * titleLineStagger;
      const localEnd   = localStart + titleLineDuration;
      if (titleP >= localStart && titleP <= localEnd) { activeLine = i; break; }
      if (titleP > localEnd) activeLine = i;
    }
    const lp = _easeOutCubic(_windowed(titleP, activeLine * titleLineStagger, activeLine * titleLineStagger + titleLineDuration));
    const cursorX = PAD_P + (W_P - PAD_P * 2) * lp;
    const cursorY = titleStartY + activeLine * titleLineH;
    titleSvgFragments.push(`
      <rect x="${cursorX}" y="${cursorY - titleSize + 8}" width="3" height="${titleSize - 6}"
            fill="${BRAND.gold}" opacity="${0.7 + 0.3 * (1 - lp)}"/>
    `);
  }
  const titleSvg = titleSvgFragments.join('\n');
  const titleBottomY = titleStartY + (titleLines.length - 1) * titleLineH;

  // ── Description: fade up (slight slide-from-below + opacity tween) ──
  const descTrimmed = (description || '').trim();
  const descCapped = descTrimmed.length > 360
    ? descTrimmed.slice(0, 357).replace(/\s+\S*$/, '') + '…'
    : descTrimmed;
  const descLines = _wrapLines(descCapped, 38, 6);
  const descSize  = 30;
  const descLineH = 42;
  const descStartY = titleBottomY + 64;
  const descOpacity = _easeOutCubic(descP) * 0.78; // cap at 0.78 (matches final fill alpha)
  const descSlideY  = (1 - _easeOutCubic(descP)) * 16; // 16px → 0
  const descSvg = descLines.map((line, i) => {
    const y = descStartY + i * descLineH + descSlideY;
    return `<text x="${PAD_P}" y="${y}"
                  font-family="${FONT_FAMILY}"
                  font-weight="500" font-size="${descSize}" letter-spacing="-0.2"
                  fill="rgba(255,255,255,${descOpacity.toFixed(3)})">${_esc(line)}</text>`;
  }).join('\n');

  // ── Flag chips: each chip slides in from x=-30 + fades in, staggered ──
  const chipsY = H_P - 280;
  const chipsBaseSvg = await _flagChips(isos, PAD_P, chipsY);
  // Wrap each chip's `<g>` in a per-chip animated transform + opacity.
  // _flagChips returns a sequence of <g transform="translate(...)">...
  // We post-process to add animation. Stagger: 70ms each.
  const chipsList = (isos || []).slice(0, 6);
  const chipStagger = 0.10; // within the chipsP window
  const chipDuration = 0.40;
  const chipsAnimated = chipsBaseSvg.replace(/<g transform="translate\(([\d.]+), ([\d.]+)\)">([\s\S]*?)<\/g>/g, (m, gx, gy, inner, ...args) => {
    // approximate ordering: replace in order they appear
    return `__CHIP_TOKEN__${gx}__${gy}__${Buffer.from(inner).toString('base64')}__`;
  });
  let chipIdx = 0;
  const chipsSvg = chipsAnimated.replace(/__CHIP_TOKEN__([\d.]+)__([\d.]+)__([A-Za-z0-9+/=]+)__/g, (m, gx, gy, b64) => {
    const inner = Buffer.from(b64, 'base64').toString('utf8');
    const i = chipIdx++;
    const localStart = i * chipStagger;
    const localEnd   = localStart + chipDuration;
    const lp = _easeOutCubic(_windowed(chipsP, localStart, localEnd));
    const dx = -30 * (1 - lp);
    return `<g transform="translate(${parseFloat(gx) + dx}, ${gy})" opacity="${lp.toFixed(3)}">${inner}</g>`;
  });

  // ── Coverage line: simple fade-in ──
  const coverageText = _coverageLine({ articleCount, languageCount, countryCount });
  const coverageSvg = coverageText ? `
    <text x="${PAD_P}" y="${chipsY - 28}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="24" letter-spacing="1.8"
          fill="${BRAND.goldSoft}" opacity="${coverageP.toFixed(3)}">${_esc(coverageText.toUpperCase())}</text>
  ` : '';

  // ── Category eyebrow: always visible ──
  // x shifted to PAD_P+32 to make room for the pulsing dot (effect #12)
  // that lives at PAD_P+10, vertically aligned with the eyebrow's
  // cap-mid so dot + text read as one inline element.
  const catLabel = (category || 'Story').toUpperCase();
  const catSvg = `
    <text x="${PAD_P + 32}" y="240"
          font-family="${FONT_FAMILY}"
          font-weight="800" font-size="26" letter-spacing="5"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY THREAD</text>
  `;

  // ── Logo: the real apple-touch-icon PNG. Static (no scale-pulse)
  // because the PNG has a rounded-rect background baked in that can't
  // be isolated from the e+globe inside, and pulsing the whole thing
  // (including bg shape) reads as awkward. The halo behind (effect #8)
  // still provides the breathing motion. ──
  const ICON_SIZE_P = 120;
  const iconY = 80;
  const iconCx = PAD_P + ICON_SIZE_P / 2;
  const iconCy = iconY + ICON_SIZE_P / 2;
  const iconBlock = _renderInlineLogo({
    cx: iconCx, cy: iconCy, size: ICON_SIZE_P,
  });

  // Brand footer (always visible — it's the wordmark, not animated).
  const footerSvg = `
    <text x="${PAD_P}" y="${H_P - 80}"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="30" letter-spacing="2"
          fill="${BRAND.goldSoft}">earth00.com</text>
  `;

  // ── Effect #14: drifting topographic contour lines in BG (decor). ──
  // Six sinusoidal paths at different y bands, very low opacity, slowly
  // drifting horizontally. Phase-shifted per-line so the field feels
  // organic, not parallel.
  const contourSvg = (() => {
    const lines = [];
    const yBands = [180, 360, 540, 720, 900, 1080, 1240];
    for (let i = 0; i < yBands.length; i++) {
      const baseY = yBands[i];
      // Each line drifts at a slightly different speed for parallax.
      const drift = p * (40 + i * 15) % 200;
      const amp = 18 + (i % 3) * 6;
      // Build a smooth quadratic-segmented wave across the whole canvas.
      const segs = [];
      for (let x = -200; x <= W_P + 200; x += 120) {
        const phase = (x + drift) * 0.015 + i * 0.7;
        const y = baseY + Math.sin(phase) * amp;
        if (x === -200) segs.push(`M ${x.toFixed(1)} ${y.toFixed(1)}`);
        else            segs.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      lines.push(`<path d="${segs.join(' ')}" fill="none" stroke="${BRAND.gold}" stroke-width="1" opacity="0.045"/>`);
    }
    return lines.join('\n');
  })();

  // ── Effect #13: radial gradient pulse from logo position (breathing). ──
  // Adds a second radial gradient centered on the logo whose radius +
  // intensity oscillate over the clip — one full breath cycle (3s).
  // Coexists with the static #glowP gradient already on the BG.
  const pulsePhase = (Math.sin(p * Math.PI * 2 - Math.PI / 2) + 1) / 2; // 0..1..0
  const pulseR = 0.32 + pulsePhase * 0.18; // 0.32 → 0.50 → 0.32 in svg-fraction units
  const pulseOpacity = 0.04 + pulsePhase * 0.06; // peak 0.10
  const radialPulseSvg = `
    <defs>
      <radialGradient id="radialPulseP" cx="${PAD_P + ICON_SIZE_P / 2}" cy="${iconY + ICON_SIZE_P / 2}" r="${pulseR * W_P}"
                      gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${BRAND.gold}" stop-opacity="${pulseOpacity.toFixed(3)}"/>
        <stop offset="1" stop-color="${BRAND.gold}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W_P}" height="${H_P}" fill="url(#radialPulseP)"/>
  `;

  // ── Effect #2: bottom-edge horizon arc (sunrise glow). ──
  // Wide elliptical glow rising from the bottom of the canvas. Fades in
  // over the first 20% of the clip, then sits at a low ambient level.
  const horizonRiseP = _easeOutCubic(_windowed(p, 0.05, 0.25));
  const horizonOpacity = 0.04 + horizonRiseP * 0.10;
  const horizonSvg = `
    <defs>
      <radialGradient id="horizonP" cx="0.5" cy="1.0" r="0.55" gradientUnits="objectBoundingBox">
        <stop offset="0"   stop-color="${BRAND.gold}" stop-opacity="${horizonOpacity.toFixed(3)}"/>
        <stop offset="0.7" stop-color="${BRAND.gold}" stop-opacity="${(horizonOpacity * 0.30).toFixed(3)}"/>
        <stop offset="1"   stop-color="${BRAND.gold}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="0" y="${H_P - 320}" width="${W_P}" height="320" fill="url(#horizonP)"/>
  `;

  // ── Effect #5: particle dust drifting up. ──
  // 22 deterministic dots scattered across the canvas, each drifting
  // upward + slight horizontal sway. Loops vertically (wraps from top
  // back to bottom) so the field stays full across the 3s clip.
  const dustSvg = (() => {
    const dots = [];
    for (let i = 0; i < 22; i++) {
      // Deterministic pseudo-random positions via sin hashing
      const seed = i * 73.7;
      const baseX = ((Math.sin(seed) * 10000) % 1 + 1) % 1 * W_P;
      const phase = ((Math.cos(seed) * 10000) % 1 + 1) % 1;
      const speed = 280 + i * 7;
      // Loop vertically over the clip
      const yTotal = (phase + p) * 1.5;            // 1.5 cycles per clip
      const y = (1 - (yTotal % 1)) * (H_P + 100) - 50;
      const x = baseX + Math.sin(p * Math.PI * 2 + i) * 8;
      const r = 1 + (i % 3) * 0.7;
      // Twinkle opacity
      const opacity = 0.20 + Math.sin(p * Math.PI * 4 + i * 1.3) * 0.18;
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${BRAND.cream}" opacity="${Math.max(0, opacity).toFixed(3)}"/>`);
    }
    return dots.join('\n');
  })();

  // ── Effect #8: pulsing gold halo around the app icon. ──
  // Circle behind logo whose radius + opacity oscillate. Sits between
  // background and logo so the halo reads behind the icon.
  const haloSvg = _renderLogoHalo({ cx: iconCx, cy: iconCy, size: ICON_SIZE_P, p, frequency: 2 });

  // ── Effect #12: eyebrow's left-side gold dot (record-indicator pulse). ──
  // Small filled circle to the left of the eyebrow text, pulsing at ~2Hz.
  const dotOpacity = 0.45 + (Math.sin(p * Math.PI * 4) + 1) / 2 * 0.50;
  // Dot is centered vertically with the eyebrow text's cap-height
  // (text baseline = 240, font-size 26 weight 800 → cap-top ~221,
  // cap-mid ~230). Sits inline with the eyebrow to its left at
  // PAD_P+10; the eyebrow's x is shifted to PAD_P+32 (see catSvg)
  // to leave breathing room around the dot.
  const eyebrowDotSvg = `
    <circle cx="${PAD_P + 10}" cy="230" r="5" fill="${BRAND.gold}" opacity="${dotOpacity.toFixed(3)}"/>
  `;

  // ── Effect #11: chromatic shimmer on title at completion. ──
  // Brief one-shot pass: at the moment the title finishes typing, render
  // two extra title copies offset by ±2px in cool-cyan and warm-rose,
  // fading out over 200ms. Reads as a quick "data refresh" flicker.
  const titleDoneP = (titleLines.length - 1) * titleLineStagger + titleLineDuration; // in titleP space
  const titleDoneGlobalP = 0.00 + titleDoneP * 0.35;                                  // back to global p
  const shimmerWindow = _easeOutCubic(_clamp(1 - (p - titleDoneGlobalP) / 0.12, 0, 1));
  const shimmerOpacity = (p >= titleDoneGlobalP && p < titleDoneGlobalP + 0.12)
    ? shimmerWindow * 0.55
    : 0;
  const chromaticShimmerSvg = shimmerOpacity > 0 ? titleLines.map((line, i) => {
    const y = titleStartY + i * titleLineH;
    return `
      <text x="${PAD_P - 2}" y="${y}"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="${titleSize}" letter-spacing="-2"
            fill="#7ec8ff" opacity="${shimmerOpacity.toFixed(3)}">${_esc(line)}</text>
      <text x="${PAD_P + 2}" y="${y}"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="${titleSize}" letter-spacing="-2"
            fill="#ff8b7a" opacity="${shimmerOpacity.toFixed(3)}">${_esc(line)}</text>
    `;
  }).join('\n') : '';

  // ── Effect #4: vertical scan-line CRT pass (top → bottom, once). ──
  // Extracted into _renderScanLine helper so slides 3 + 4 use the same
  // effect — gives the carousel a unified scanning-line accent.
  const scanLineGlobalSvg = _renderScanLine({ p });

  // ── Effect #1: gold border trace (one-shot perimeter run). ──
  // Extracted into _renderBorderTrace helper so slides 3 + 4 use the
  // same effect — gives the carousel a unified moving-edge accent.
  const borderTraceSvg = _renderBorderTrace({ p });

  // ── Effect #18: chips float gently (sinusoidal Y offset). ──
  // Inject a per-chip vertical bobble on top of the existing slide-in
  // transform. Each chip gets a phase offset so they don't move in unison.
  // Float only AFTER chips are settled (chipsP done). 4px amplitude.
  let _chipFloatIdx = 0;
  const chipsFloatSvg = chipsSvg.replace(
    /<g transform="translate\(([\d.-]+), ([\d.-]+)\)"([^>]*)>/g,
    (m, gx, gy, rest) => {
      const idx = _chipFloatIdx++;
      const settled = chipsP >= 1 ? 1 : 0;
      const bobble = settled
        ? Math.sin(p * Math.PI * 2 + idx * 0.9) * 4
        : 0;
      const newGy = parseFloat(gy) + bobble;
      return `<g transform="translate(${gx}, ${newGy.toFixed(2)})"${rest}>`;
    }
  );

  const bg = `
    <defs>
      <linearGradient id="bgGradP" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${BRAND.bgTop}"/>
        <stop offset="1" stop-color="${BRAND.bgBot}"/>
      </linearGradient>
      <radialGradient id="glowP" cx="0.5" cy="0.55" r="0.7">
        <stop offset="0" stop-color="rgba(212,168,67,0.06)"/>
        <stop offset="1" stop-color="rgba(212,168,67,0)"/>
      </radialGradient>
    </defs>
    <rect width="${W_P}" height="${H_P}" fill="url(#bgGradP)"/>
    <rect width="${W_P}" height="${H_P}" fill="url(#glowP)"/>
  `;

  // Z-order, back→front: bg → contours → radial pulse → horizon →
  // particle dust → halo → icon → eyebrow dot → eyebrow → title →
  // chromatic shimmer overlay → desc → coverage → chips (with float)
  // → scan-line → border trace → footer.
  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W_P}" height="${H_P}" viewBox="0 0 ${W_P} ${H_P}">
      ${bg}
      ${contourSvg}
      ${radialPulseSvg}
      ${horizonSvg}
      ${dustSvg}
      ${haloSvg}
      ${iconBlock}
      ${eyebrowDotSvg}
      ${catSvg}
      ${titleSvg}
      ${chromaticShimmerSvg}
      ${descSvg}
      ${coverageSvg}
      ${chipsFloatSvg}
      ${scanLineGlobalSvg}
      ${borderTraceSvg}
      ${footerSvg}
    </svg>
  `;
}

// ─── Coverage pie chart (1080×1350, country spread) ──────────────────
// Third slide of the Instagram carousel: a donut chart showing where
// the thread is being covered — distinct sources grouped by country.
// More useful "geographic reach" signal than source bias, which is
// editorially fraught and not always well-classified.
//
// Top-N countries get their own slice; if there's a long tail, the
// remainder collapses into an 'Other' bucket. Slice colors come from
// a curated 8-hue palette tuned to read against the dark BG and feel
// brand-consistent (gold, coral, teal, etc.).
const COUNTRY_SLICE_COLORS = [
  '#d4a843', // brand gold
  '#5fb3d9', // sky blue
  '#e16d5c', // coral
  '#88c69a', // sage
  '#c89aff', // soft violet
  '#f4d77a', // pale gold
  '#85a8c4', // dusty blue
  '#3a4458', // muted slate (used for "Other")
];
const COUNTRY_OTHER_COLOR = '#3a4458';

function _polarToCartesian(cx, cy, r, angleRad) {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function _donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  // Angles in radians, 0 = right (3 o'clock), clockwise.
  const p1 = _polarToCartesian(cx, cy, rOuter, startAngle);
  const p2 = _polarToCartesian(cx, cy, rOuter, endAngle);
  const p3 = _polarToCartesian(cx, cy, rInner, endAngle);
  const p4 = _polarToCartesian(cx, cy, rInner, startAngle);
  const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

async function _renderThreadCoveragePieSvg({ title, category, countryCounts, articleCount, sourceCount, animation }) {
  const p = animation ? _clamp(animation.progress, 0, 1) : 1;
  // Front-loaded timeline so the first ~1s already shows the brand +
  // typing title — prevents the "blank first half-second" that lets
  // viewers scroll past before anything registers.
  //   chrome:    instant (always visible)
  //   title:     0.00 → 0.30  (per-line wipe)
  //   subtitle:  0.25 → 0.40
  //   donut:     0.30 → 0.65  (sweep clockwise)
  //   center #:  0.35 → 0.70  (tween 0 → total)
  //   legend:    0.65 → 0.90  (staggered rows)
  const chromeP   = 1;                                                // always on
  const titleP    = _windowed(p, 0.00, 0.30);
  const subP      = _easeOutCubic(_windowed(p, 0.25, 0.40));
  const donutP    = _easeOutCubic(_windowed(p, 0.30, 0.65));
  const counterP  = _easeOutCubic(_windowed(p, 0.35, 0.70));
  const legendP   = _windowed(p, 0.65, 0.90);

  // countryCounts: [{ iso: 'us', name: 'United States', count: 24 }, ...]
  // already sorted desc by count. Caller may pass an empty array;
  // in that case the donut renders as an empty ring with a "—" center.
  const allCountries = Array.isArray(countryCounts) ? countryCounts.filter(c => Number(c.count) > 0) : [];
  // Top 7 get their own slice; remainder collapses into "Other".
  const TOP_N = 7;
  let slices;
  if (allCountries.length <= TOP_N) {
    slices = allCountries.map((c, i) => ({
      iso: String(c.iso || '').toLowerCase(),
      name: c.name || (c.iso ? String(c.iso).toUpperCase() : 'Unknown'),
      count: Number(c.count) || 0,
      color: COUNTRY_SLICE_COLORS[i % COUNTRY_SLICE_COLORS.length],
    }));
  } else {
    const top = allCountries.slice(0, TOP_N);
    const tail = allCountries.slice(TOP_N);
    const tailCount = tail.reduce((a, b) => a + (Number(b.count) || 0), 0);
    slices = top.map((c, i) => ({
      iso: String(c.iso || '').toLowerCase(),
      name: c.name || (c.iso ? String(c.iso).toUpperCase() : 'Unknown'),
      count: Number(c.count) || 0,
      color: COUNTRY_SLICE_COLORS[i % COUNTRY_SLICE_COLORS.length],
    }));
    slices.push({
      iso: null,
      name: `+${tail.length} more`,
      count: tailCount,
      color: COUNTRY_OTHER_COLOR,
    });
  }
  const total = slices.reduce((a, b) => a + b.count, 0);
  // Pre-warm flag cache for slice flags (used in legend rendering).
  await Promise.all(slices.map(s => s.iso ? _flagDataUri(s.iso) : Promise.resolve(null)));

  // ── Top zone: bigger logo (120×120) + category eyebrow ──
  // Chrome is always-on. Halo behind logo matches slide 1's breathing
  // motion for visual continuity across the carousel.
  const ICON_SIZE_P = 120;
  const iconY = 80;
  const iconCx = PAD_P + ICON_SIZE_P / 2;
  const iconCy = iconY + ICON_SIZE_P / 2;
  const haloSvg = _renderLogoHalo({ cx: iconCx, cy: iconCy, size: ICON_SIZE_P, p, frequency: 2 });
  const iconBlock = _renderInlineLogo({ cx: iconCx, cy: iconCy, size: ICON_SIZE_P });

  const catLabel = (category || 'Story').toUpperCase();
  const catSvg = `
    <text x="${PAD_P}" y="240"
          font-family="${FONT_FAMILY}"
          font-weight="800" font-size="26" letter-spacing="5"
          fill="${BRAND.gold}">${_esc(catLabel)} · COVERAGE BY COUNTRY</text>
  `;

  // ── Title: auto-shrink + per-line wipe ──
  const titleFit = _fitTitle(title || 'Coverage', [
    { size: 50, lineH: 64, charsPerLine: 26, maxLines: 2 },
    { size: 44, lineH: 56, charsPerLine: 30, maxLines: 3 },
    { size: 38, lineH: 50, charsPerLine: 36, maxLines: 3 },
  ]);
  const titleLines  = titleFit.lines;
  const titleSize   = titleFit.size;
  const titleLineH  = titleFit.lineH;
  const titleStartY = 340;

  // Slowed: per-line wipe duration 0.22 → 0.40, stagger 0.10 → 0.16
  // (in titleP-space). At the previous speed the title finished
  // typing in ~280ms wallclock; the new pace pushes it to ~510ms so
  // the wipe actually reads as motion rather than a snap-in.
  const titleLineDuration = 0.40;
  const titleLineStagger  = 0.16;
  const titleSvgFragments = titleLines.map((line, i) => {
    const localStart = i * titleLineStagger;
    const localEnd   = localStart + titleLineDuration;
    const lp = _easeOutCubic(_windowed(titleP, localStart, localEnd));
    const y = titleStartY + i * titleLineH;
    const clipId = `pieTitleClip${i}`;
    const clipW = (W_P - PAD_P * 2) * lp + 4;
    return `
      <defs>
        <clipPath id="${clipId}">
          <rect x="${PAD_P - 4}" y="${y - titleSize}" width="${clipW}" height="${titleSize + 20}"/>
        </clipPath>
      </defs>
      <text x="${PAD_P}" y="${y}"
            clip-path="url(#${clipId})"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="${titleSize}" letter-spacing="-1.5"
            fill="${BRAND.cream}">${_esc(line)}</text>
    `;
  });
  const titleSvg = titleSvgFragments.join('\n');
  const titleBottomY = titleStartY + (titleLines.length - 1) * titleLineH;

  // ── Subtitle: how many distinct sources + articles + countries ──
  const subBits = [];
  if (Number.isFinite(sourceCount)  && sourceCount  > 0) subBits.push(`${sourceCount} SOURCES`);
  if (Number.isFinite(articleCount) && articleCount > 0) subBits.push(`${articleCount} ARTICLES`);
  if (allCountries.length > 0)                            subBits.push(`${allCountries.length} COUNTR${allCountries.length === 1 ? 'Y' : 'IES'}`);
  const subText = subBits.join(' · ');
  const subY = titleBottomY + 46;
  const subSvg = subText ? `
    <text x="${PAD_P}" y="${subY}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="22" letter-spacing="2"
          fill="${BRAND.goldSoft}" opacity="${subP.toFixed(3)}">${_esc(subText)}</text>
  ` : '';

  // ── Donut geometry ──
  const cx = W_P / 2;
  const cy = 720;
  const rOuter = 210;
  const rInner = 115;

  // ── Effect #17: background world-map silhouette (stylized globe wireframe). ──
  // A faint dotted-circle + latitude/longitude wireframe centered well
  // behind the donut, suggesting "earth" without literal continents.
  // Very low opacity (3-7%) so it whispers rather than competes.
  const globeBgSvg = (() => {
    const gcx = cx;
    const gcy = cy;
    const gR  = 380;
    // Latitude ellipses (squashed circles to mimic equator + tropics)
    const lats = [0.30, 0.60, 0.85, 1.00, 0.85, 0.60, 0.30].map((rf, i) => {
      const ry = gR * (1 - i * 0.14);
      // shift each lat band's center vertically
      const ycy = gcy - gR * 0.85 + i * gR * 0.28;
      return `<ellipse cx="${gcx}" cy="${ycy}" rx="${gR * rf}" ry="${Math.max(1, ry * 0.05)}"
                       fill="none" stroke="${BRAND.gold}" stroke-width="1" opacity="0.04"/>`;
    }).join('\n');
    // Longitude curves (using arcs through a sphere projection — fake it
    // with ellipses rotated about cy).
    const longs = [];
    for (let i = 0; i < 5; i++) {
      const rx = gR * (i / 4) * 0.95 + 30;
      longs.push(`<ellipse cx="${gcx}" cy="${gcy}" rx="${rx}" ry="${gR}"
                           fill="none" stroke="${BRAND.gold}" stroke-width="1" opacity="0.035"/>`);
    }
    // Outer globe outline
    const outline = `<circle cx="${gcx}" cy="${gcy}" r="${gR}" fill="none"
                             stroke="${BRAND.gold}" stroke-width="1.2" opacity="0.06"/>`;
    return outline + '\n' + lats + '\n' + longs.join('\n');
  })();

  // ── Effects #2 (slice pop) + #3 (slow rotation) + #1 (trace dot) + #5 (inner pulse) ──
  // Donut rotation (effect #3): starts at 0°, after donut completes
  // (donutP=1, global p≈0.65), rotates slowly by ~14° over the remainder.
  const rotationP = _easeOutCubic(_clamp((p - 0.65) / 0.35, 0, 1));
  const donutRotateDeg = rotationP * 14;

  // Inner pulse (effect #5): at the moment of donut completion, rInner
  // expands by ~8px and decays back. Active for p in [0.62, 0.78].
  const innerPulseP = _clamp((p - 0.62) / 0.16, 0, 1);
  const innerPulseAmt = innerPulseP > 0 && innerPulseP < 1
    ? Math.sin(innerPulseP * Math.PI) * 8
    : 0;
  const liveRInner = rInner + innerPulseAmt;

  // Donut sweep build
  let slicesSvg = '';
  let traceDotSvg = '';
  if (total > 0 && slices.length > 0) {
    const startAngle0 = -Math.PI / 2;
    const TWO_PI = Math.PI * 2;
    const sweepFrac = donutP;
    const sweepEndAngle = startAngle0 + TWO_PI * sweepFrac;

    let angle = startAngle0;
    for (const s of slices) {
      const frac = s.count / total;
      const end  = angle + frac * TWO_PI;
      if (sweepEndAngle > angle) {
        const visEnd = Math.min(end, sweepEndAngle);
        if (visEnd - angle > 0.001) {
          // ── Effect #2: slice pop on landing. ──
          // When the sweep is INSIDE this slice (visEnd < end), the slice
          // is currently growing — give it a +3px outward push at the
          // leading edge. Once the sweep moves past, settles back. We
          // pulse the rOuter by + popAmt as long as visEnd is within
          // 200ms of crossing this slice's end.
          const sliceLandPhase = _clamp((visEnd - angle) / (end - angle), 0, 1);
          const popActive = visEnd >= end - 0.06 && visEnd <= end;
          const popAmt = popActive ? (1 - (end - visEnd) / 0.06) * 4 : 0;
          const liveROuter = rOuter + popAmt;
          if (slices.length === 1 && sweepFrac >= 1) {
            slicesSvg += `<circle cx="${cx}" cy="${cy}" r="${liveROuter}" fill="${s.color}"/>`;
            slicesSvg += `<circle cx="${cx}" cy="${cy}" r="${liveRInner}" fill="${BRAND.bgBot}"/>`;
          } else {
            slicesSvg += `<path d="${_donutSlicePath(cx, cy, liveROuter, liveRInner, angle, visEnd)}" fill="${s.color}"/>`;
          }
        }
      }
      angle = end;
    }
    // Faint backing ring during sweep
    if (donutP > 0 && donutP < 1) {
      slicesSvg = `
        <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none"
                stroke="rgba(255,255,255,0.05)" stroke-width="${rOuter - rInner}"/>
      ` + slicesSvg;
    }

    // ── Effect #1: glowing trace dot at the sweep's leading edge ──
    if (donutP > 0 && donutP < 1) {
      const traceAngle = sweepEndAngle;
      // Position dot on the outer edge (+2px) so it reads as the "tip"
      // of the sweep, not buried inside the slice.
      const tracePt = _polarToCartesian(cx, cy, rOuter + 2, traceAngle);
      traceDotSvg = `
        <circle cx="${tracePt.x.toFixed(1)}" cy="${tracePt.y.toFixed(1)}" r="10"
                fill="${BRAND.gold}" opacity="0.20"/>
        <circle cx="${tracePt.x.toFixed(1)}" cy="${tracePt.y.toFixed(1)}" r="5"
                fill="${BRAND.cream}" opacity="0.95"/>
      `;
    }
  } else {
    slicesSvg = `
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="rgba(255,255,255,0.06)"/>
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="${BRAND.bgBot}"/>
    `;
  }

  // ── Pointillist emissive glow ──
  // Dense field of tiny gold dots scattered radially outward from the
  // donut's outer edge. Each dot renders as a bright center circle
  // PLUS a larger faint halo so individual dots feel slightly glowing
  // rather than flat. All small (1.0-2.2px center) with varied sizes
  // so the field reads as organic emission, not a regular pattern.
  // Uniformly gold (BRAND.gold) — the slice colors live inside the
  // donut and the legend chips; the emissive halo is the brand mark.
  // Density falls off with distance from the donut edge.
  let pointillistGlowSvg = '';
  if (total > 0 && slices.length > 0) {
    const startAngle0 = -Math.PI / 2;
    const TWO_PI = Math.PI * 2;
    let angle = startAngle0;
    for (let sIdx = 0; sIdx < slices.length; sIdx++) {
      const s = slices[sIdx];
      const frac = s.count / total;
      const end  = angle + frac * TWO_PI;
      const midAngle = (angle + end) / 2;
      const sliceSpread = (end - angle) * 0.92;        // wider fan
      const sliceRevealed = _clamp((donutP - (sIdx / slices.length)) * slices.length, 0, 1);
      const ambient = donutP >= 1
        ? 0.7 + 0.3 * (Math.sin(p * Math.PI * 2.5 + sIdx * 0.7) + 1) / 2
        : 1;
      // Density bumped: 32 dots per slice (was 14). With ~8 slices that's
      // ~256 dots scattered around the donut perimeter — a thick gold
      // emission field rather than a sparse halo.
      const dotsPerSlice = 32;
      for (let k = 0; k < dotsPerSlice; k++) {
        // Deterministic pseudo-random
        const seedA = Math.sin(sIdx * 17.3 + k * 7.7);
        const seedB = Math.cos(sIdx * 11.1 + k * 5.3);
        const seedC = Math.sin(sIdx * 5.1 + k * 2.3 + 0.7);
        const angOffset = (seedA * 0.5) * sliceSpread;
        const dotAngle = midAngle + angOffset;
        // Radial distance: cluster near outer edge, fall off out to ~75px.
        const rJitter = (Math.abs(seedB) * 0.85 + 0.15);
        const distOut = rJitter * 75;
        // All SMALL but varied. Center dot radius: 0.6 → 2.2px.
        const dotR = 0.6 + Math.abs(seedC) * 1.6;
        const fall = Math.pow(1 - rJitter, 1.4);
        const centerOpacity = 0.85 * fall * sliceRevealed * ambient;
        const haloOpacity   = 0.18 * fall * sliceRevealed * ambient;
        const px = cx + Math.cos(dotAngle) * (rOuter + 4 + distOut);
        const py = cy + Math.sin(dotAngle) * (rOuter + 4 + distOut);
        // Two-circle render per dot: faint halo (2.4× radius) for the
        // "slightly glowing" feel + bright center.
        pointillistGlowSvg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(dotR * 2.4).toFixed(2)}"
                                       fill="${BRAND.gold}" opacity="${haloOpacity.toFixed(3)}"/>`;
        pointillistGlowSvg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${dotR.toFixed(2)}"
                                       fill="${BRAND.gold}" opacity="${centerOpacity.toFixed(3)}"/>`;
      }
      angle = end;
    }
  }

  // ── Emissive glow halo (behind dots) ──
  // Soft gold radial halo sitting in the annulus between the donut's
  // outer edge and the end of the pointillist dot field. Provides a
  // warm atmosphere for the dots to sit in without competing with
  // them — peak opacity is intentionally low (~12%) so the dots stay
  // the visual focus. Fades in over the same window as the donut
  // sweep so it doesn't pop in before the chart exists.
  const emissiveGlowFade = _easeOutCubic(_windowed(p, 0.40, 0.75));
  const emissiveGlowR    = rOuter + 90;       // outer reach of the glow
  const emissiveGlowSvg = emissiveGlowFade > 0 ? `
    <defs>
      <radialGradient id="emissiveDonutGlow" cx="${cx}" cy="${cy}" r="${emissiveGlowR}" gradientUnits="userSpaceOnUse">
        <stop offset="${(rOuter / emissiveGlowR - 0.02).toFixed(3)}" stop-color="${BRAND.gold}" stop-opacity="0"/>
        <stop offset="${((rOuter + 25) / emissiveGlowR).toFixed(3)}" stop-color="${BRAND.gold}" stop-opacity="${(0.13 * emissiveGlowFade).toFixed(3)}"/>
        <stop offset="${((rOuter + 70) / emissiveGlowR).toFixed(3)}" stop-color="${BRAND.gold}" stop-opacity="${(0.05 * emissiveGlowFade).toFixed(3)}"/>
        <stop offset="1.0" stop-color="${BRAND.gold}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${emissiveGlowR}" fill="url(#emissiveDonutGlow)"/>
  ` : '';

  // Wrap slices + emissive halo + pointillist dots + trace dot in a rotation
  // group (effect #3). Z-order back→front: emissive halo → slices →
  // pointillist dots → trace dot. Halo sits behind everything else so
  // dots glow ON TOP of it; slices stay crisp because the halo is
  // transparent inside rOuter.
  const donutGroupSvg = `
    <g transform="rotate(${donutRotateDeg.toFixed(2)} ${cx} ${cy})">
      ${emissiveGlowSvg}
      ${slicesSvg}
      ${pointillistGlowSvg}
      ${traceDotSvg}
    </g>
  `;

  // ── Effect #7: center number with odometer-style stutter. ──
  // The integer count tweens up to its final value, but with a small
  // sin-driven Y wobble so each digit transition feels like a mechanical
  // "click" rather than a smooth slide. Wobble fades out once the
  // counter completes.
  const liveCountryCount = Math.round(allCountries.length * counterP);
  const counterStill = counterP >= 1 ? 1 : 0;
  // Y-bounce when counter is actively changing — sine bobble that decays
  // as counterP approaches 1. ~3px max amplitude.
  const counterBounce = counterP > 0 && counterP < 1
    ? Math.sin(counterP * Math.PI * allCountries.length * 1.4) * 3 * (1 - counterP)
    : 0;
  const centerOpacity = _easeOutCubic(_windowed(p, 0.30, 0.45));
  const centerLabel = `
    <text x="${cx}" y="${(cy - 6 + counterBounce).toFixed(2)}" text-anchor="middle"
          font-family="${FONT_FAMILY}" font-weight="800" font-size="72"
          fill="${BRAND.cream}" opacity="${centerOpacity.toFixed(3)}">${liveCountryCount || 0}</text>
    <text x="${cx}" y="${cy + 34}" text-anchor="middle"
          font-family="${FONT_FAMILY}" font-weight="700" font-size="18"
          letter-spacing="3" fill="${BRAND.goldSoft}" opacity="${centerOpacity.toFixed(3)}">${allCountries.length === 1 ? 'COUNTRY' : 'COUNTRIES'}</text>
  `;

  // ── Legend with effects #12 (row pulse), #13 (underline), #19 (count tween), #20 (flag wave) ──
  const legendY = cy + rOuter + 56; // ~986
  const legendItems = slices.length ? slices : [];
  const legendStagger  = 0.08;
  const legendDuration = 0.25;
  // Row-pulse cascade: after all rows have landed (legendP ≥ 1), cycle a
  // brightness highlight through them. Cycle takes ~250ms per row.
  const cascadeStartGlobal = 0.90;                                  // global p
  const cascadeRowDur      = (1.0 - cascadeStartGlobal) / Math.max(1, legendItems.length);

  const legendSvg = legendItems.map((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = PAD_P + col * 460;
    const baseY = legendY + row * 50;
    const localStart = i * legendStagger;
    const localEnd   = localStart + legendDuration;
    const lp = _easeOutCubic(_windowed(legendP, localStart, localEnd));
    const slideY = (1 - lp) * 14;
    const y = baseY + slideY;

    // Effect #19: per-row count tween. Each row counts up to its final
    // value over its appearance window (same window as the slide-in lp).
    const rowCountP = _easeOutCubic(_windowed(legendP, localStart, localEnd));
    const liveCount = Math.round(s.count * rowCountP);
    const livePct   = total > 0 && rowCountP > 0
      ? Math.round((liveCount / total) * 100)
      : 0;

    // Effect #12: cascade pulse — row brightens briefly when the cascade
    // sweep reaches its index.
    const cascadeRowStart = cascadeStartGlobal + i * cascadeRowDur;
    const cascadeRowMid   = cascadeRowStart + cascadeRowDur * 0.4;
    const pulseDist       = Math.abs(p - cascadeRowMid);
    const pulseBoost      = (p >= cascadeStartGlobal && pulseDist < cascadeRowDur * 0.5)
      ? (1 - pulseDist / (cascadeRowDur * 0.5)) * 0.55
      : 0;

    // Color chip on the left (matches the donut slice color), brightens
    // during the cascade pulse.
    const chipOpacity = 1 + pulseBoost * 0.4;
    const chip = `<rect x="${x}" y="${y - 20}" width="14" height="26" rx="3" fill="${s.color}" opacity="${chipOpacity.toFixed(3)}"/>`;

    // Flag with effect #20 (skew-x sinusoidal wave on entry, then settle).
    const flagUri = s.iso ? _flagCache.get(s.iso) : null;
    // Wave is most active when the row is JUST appearing (lp 0→1), then
    // fades to a tiny ambient sway after.
    const waveStrength = lp < 1 ? (1 - lp) : 0.2 * (p < 0.95 ? 1 : 0);
    const waveAngle = waveStrength > 0
      ? Math.sin(p * Math.PI * 8 + i * 0.7) * 8 * waveStrength
      : 0;
    const flagCx2 = x + 24 + 12;
    const flagCy2 = y - 8;
    const flagSvg = flagUri
      ? `<g transform="translate(${flagCx2} ${flagCy2}) skewX(${waveAngle.toFixed(2)}) translate(${-flagCx2} ${-flagCy2})">
           <image x="${x + 24}" y="${y - 16}" width="24" height="16" href="${flagUri}" preserveAspectRatio="xMidYMid slice"/>
         </g>`
      : '';
    const labelX = x + (flagUri ? 56 : 24);
    // Truncate long country names so the count column stays aligned.
    const trimmedName = (s.name || '').length > 16 ? s.name.slice(0, 15) + '…' : (s.name || '');

    // Country name text — boosted brightness during cascade pulse.
    const nameFill = pulseBoost > 0
      ? `rgba(255, 246, 220, ${(0.95 + pulseBoost * 0.5).toFixed(3)})`
      : BRAND.ink;

    // Effect #13: thin gold underline drawing L→R under each legend row
    // as it lands. Underline width = lp × full row width.
    const underlineFullW = 410;
    const underlineW = underlineFullW * lp;
    const underlineSvg = `
      <rect x="${x + 4}" y="${y + 8}" width="${underlineW.toFixed(1)}" height="0.8"
            fill="${BRAND.gold}" opacity="${(0.30 + pulseBoost * 0.6).toFixed(3)}"/>
    `;

    return `
      <g opacity="${lp.toFixed(3)}">
        ${chip}
        ${flagSvg}
        <text x="${labelX}" y="${y}"
              font-family="${FONT_FAMILY}" font-weight="600" font-size="22"
              fill="${nameFill}">${_esc(trimmedName)}</text>
        <text x="${x + 410}" y="${y}" text-anchor="end"
              font-family="${FONT_FAMILY}" font-weight="700" font-size="22"
              fill="${BRAND.goldSoft}">${liveCount}  (${livePct}%)</text>
        ${underlineSvg}
      </g>
    `;
  }).join('\n');

  const footerSvg = `
    <text x="${PAD_P}" y="${H_P - 80}"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="30" letter-spacing="2"
          fill="${BRAND.goldSoft}">earth00.com</text>
  `;

  const bg = `
    <defs>
      <linearGradient id="bgGradC" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${BRAND.bgTop}"/>
        <stop offset="1" stop-color="${BRAND.bgBot}"/>
      </linearGradient>
    </defs>
    <rect width="${W_P}" height="${H_P}" fill="url(#bgGradC)"/>
  `;

  // Z-order: bg → globe wireframe → chrome → title → subtitle →
  // donut (rotated group includes slices + trace dot) → center label →
  // legend (per-row underline embedded) → footer.
  // Scan-line passes BEHIND the donut + legend so it frames the data
  // viz rather than covering it. Border-trace stays on top.
  const scanLineGlobalSvg = _renderScanLine({ p });
  const borderTraceSvg    = _renderBorderTrace({ p });

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W_P}" height="${H_P}" viewBox="0 0 ${W_P} ${H_P}">
      ${bg}
      ${globeBgSvg}
      ${haloSvg}
      ${iconBlock}
      ${catSvg}
      ${titleSvg}
      ${subSvg}
      ${scanLineGlobalSvg}
      ${donutGroupSvg}
      ${centerLabel}
      ${legendSvg}
      ${borderTraceSvg}
      ${footerSvg}
    </svg>
  `;
}

// ─── Articles bar list (1080×1350, slide 4) ──────────────────────────
// Fourth slide of the IG carousel: 4 high-signal articles, each rendered
// as a horizontal bar with hero thumb (left) + headline + source/flag
// metadata (right). Hero images are fetched via the same throttled +
// size-capped helper as the landscape card's hero panel.

// Article-hero data-URI cache. Frame-mode rendering calls the article
// template N times (once per frame); without this, each frame would
// re-download every hero, blowing up the network and the wall-clock.
// Cache key: the URL string. Values: data-URI string or null sentinel.
const _articleHeroCache = new Map();
const ARTICLE_HERO_CACHE_MAX = 256;

// Concurrency-capped parallel hero fetch — avoids opening 4 simultaneous
// connections to slow CDNs which can stall the whole slide render.
async function _fetchArticleHero(art) {
  const candidates = [art.hero_url, art.hero_catalog_url].filter(s => typeof s === 'string' && s.trim());
  for (const u of candidates) {
    if (_articleHeroCache.has(u)) return _articleHeroCache.get(u);
    try {
      const buf = await _fetchImageBufAny(u);
      if (!buf || buf.length < 64) { _articleHeroCache.set(u, null); continue; }
      if (buf.length > HERO_MAX_BYTES) { _articleHeroCache.set(u, null); continue; }
      const mime = _detectImageMime(buf);
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
      _articleHeroCache.set(u, dataUri);
      while (_articleHeroCache.size > ARTICLE_HERO_CACHE_MAX) {
        const k = _articleHeroCache.keys().next().value;
        _articleHeroCache.delete(k);
      }
      return dataUri;
    } catch (_) {
      _articleHeroCache.set(u, null);
    }
  }
  return null;
}

function _relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  const diffMs = Date.now() - t.getTime();
  const min  = Math.floor(diffMs / 60000);
  if (min < 1)        return 'JUST NOW';
  if (min < 60)       return `${min}M AGO`;
  const hr = Math.floor(min / 60);
  if (hr < 24)        return `${hr}H AGO`;
  const day = Math.floor(hr / 24);
  if (day < 7)        return `${day}D AGO`;
  const wk = Math.floor(day / 7);
  if (wk < 5)         return `${wk}W AGO`;
  return t.toISOString().slice(0, 10).toUpperCase();
}

async function _renderThreadArticlesSvg({ title, category, articles, animation }) {
  const p = animation ? _clamp(animation.progress, 0, 1) : 1;
  // Front-loaded: chrome always on, title types in fast, bars start sliding
  // by t=0.25 so a viewer who scrolls within 1.5s sees at least 2 bars.
  const titleP   = _windowed(p, 0.00, 0.30);
  const headerP  = _easeOutCubic(_windowed(p, 0.25, 0.40));   // "TOP COVERAGE" sub-header
  const barsP    = _windowed(p, 0.30, 0.95);

  const arts = (Array.isArray(articles) ? articles : []).slice(0, 4);

  // ── Top chrome ──
  // Halo behind logo matches slide 1's breathing motion for visual
  // continuity across the carousel.
  const ICON_SIZE_P = 120;
  const iconY = 80;
  const iconCx = PAD_P + ICON_SIZE_P / 2;
  const iconCy = iconY + ICON_SIZE_P / 2;
  const haloSvg = _renderLogoHalo({ cx: iconCx, cy: iconCy, size: ICON_SIZE_P, p, frequency: 2 });
  const iconBlock = _renderInlineLogo({ cx: iconCx, cy: iconCy, size: ICON_SIZE_P });

  const catLabel = (category || 'Story').toUpperCase();
  const eyebrowSvg = `
    <text x="${PAD_P}" y="240"
          font-family="${FONT_FAMILY}"
          font-weight="800" font-size="26" letter-spacing="5"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY THREAD</text>
  `;

  // ── Title: 2 lines max, smaller than the portrait card so the bar
  // list owns the visual weight. Wipes in left-to-right per line. ──
  const titleFit = _fitTitle(title || 'Top Coverage', [
    { size: 40, lineH: 50, charsPerLine: 32, maxLines: 2 },
    { size: 34, lineH: 44, charsPerLine: 38, maxLines: 2 },
    { size: 28, lineH: 38, charsPerLine: 46, maxLines: 2 },
  ]);
  const titleStartY = 320;
  const titleLineDuration = 0.22;
  const titleSvgFragments = titleFit.lines.map((line, i) => {
    const lp = _easeOutCubic(_windowed(titleP, i * 0.08, i * 0.08 + titleLineDuration));
    const y = titleStartY + i * titleFit.lineH;
    const clipId = `artTitleClip${i}`;
    const clipW = (W_P - PAD_P * 2) * lp + 4;
    return `
      <defs>
        <clipPath id="${clipId}">
          <rect x="${PAD_P - 4}" y="${y - titleFit.size}" width="${clipW}" height="${titleFit.size + 20}"/>
        </clipPath>
      </defs>
      <text x="${PAD_P}" y="${y}"
            clip-path="url(#${clipId})"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="${titleFit.size}" letter-spacing="-1.2"
            fill="${BRAND.cream}">${_esc(line)}</text>
    `;
  });
  const titleSvg = titleSvgFragments.join('\n');
  const titleBottomY = titleStartY + (titleFit.lines.length - 1) * titleFit.lineH;

  // ── "TOP COVERAGE" header bar above the article list ──
  // Sits between the thread title and the first article row, so the
  // bars feel grouped under their own visual label. Gold underline
  // matches the chrome accent.
  const headerY  = titleBottomY + 56;
  const headerSvg = `
    <g opacity="${headerP.toFixed(3)}">
      <text x="${PAD_P}" y="${headerY}"
            font-family="${FONT_FAMILY}"
            font-weight="800" font-size="22" letter-spacing="4"
            fill="${BRAND.gold}">TOP COVERAGE</text>
      <rect x="${PAD_P}" y="${headerY + 12}" width="160" height="2" rx="1"
            fill="${BRAND.gold}" opacity="0.7"/>
    </g>
  `;

  // ── Pre-fetch hero images + warm flag cache (parallel) ──
  // Flags read synchronously from _flagCache inside the meta-row builder,
  // so the cache MUST be populated before we start mapping articles → svg.
  const [heroUris] = await Promise.all([
    Promise.all(arts.map(_fetchArticleHero)),
    Promise.all(arts.map(a => a.source_iso ? _flagDataUri(a.source_iso) : Promise.resolve(null))),
  ]);

  // ── 4 bars stacked vertically, below the "TOP COVERAGE" header ──
  const barAreaTop    = headerY + 36;
  const barAreaBottom = 1230;
  const barCount      = Math.max(1, arts.length);
  const barGap        = 16;
  const barHeight     = Math.min(170, (barAreaBottom - barAreaTop - (barCount - 1) * barGap) / barCount);

  const barStagger  = 0.16;
  const barDuration = 0.40;

  // Pseudo-random but deterministic palette for hero placeholders —
  // each fallback row gets a soft gradient + the source country flag
  // tinted into the corner so the bar still feels intentional even
  // when the publisher's CDN didn't return a usable image. Color picked
  // from the country palette (gold / coral / sage / etc.) by index.
  const PLACEHOLDER_COLORS = [BRAND.gold, '#5fb3d9', '#e16d5c', '#88c69a', '#c89aff', '#f4d77a'];

  const barsSvg = arts.map((art, i) => {
    const lp = _easeOutCubic(_windowed(barsP, i * barStagger, i * barStagger + barDuration));
    const slideX = (1 - lp) * 80; // slide in from right
    const barY = barAreaTop + i * (barHeight + barGap);
    const barW = W_P - PAD_P * 2;

    // Per-bar "settled" timeline: how far past landing we are, in the
    // remaining clip space. Drives all post-land effects (scan-line,
    // gradient sweep, flag wave, time count-up, etc.) so each bar has
    // its own beat regardless of stagger position.
    const barLandG = (i * barStagger + barDuration);                   // local g_p where this bar finishes landing
    const settledG = _windowed(barsP, barLandG, 1.0);                  // 0..1 over the rest of the bars-window

    // ── Hero thumb (left) — 140×140 rounded ──
    const thumbSize = Math.min(140, barHeight - 16);
    const thumbX = PAD_P + 12;
    const thumbY = barY + (barHeight - thumbSize) / 2;
    const thumbR = 16;
    const thumbClipId = `thumbClip${i}`;
    const iso = String(art.source_iso || '').toLowerCase();
    const flagUri = iso && _flagCache.has(iso) ? _flagCache.get(iso) : null;

    // Always emit a placeholder layer first (so even cropped images
    // bleed into a brand-colored backstop, never the dark background).
    const placeholderColor = PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length];
    const thumbSvg = heroUris[i] ? `
      <defs>
        <clipPath id="${thumbClipId}">
          <rect x="${thumbX}" y="${thumbY}" width="${thumbSize}" height="${thumbSize}" rx="${thumbR}"/>
        </clipPath>
      </defs>
      <rect x="${thumbX}" y="${thumbY}" width="${thumbSize}" height="${thumbSize}" rx="${thumbR}"
            fill="${placeholderColor}" opacity="0.18"/>
      <image x="${thumbX}" y="${thumbY}" width="${thumbSize}" height="${thumbSize}"
             clip-path="url(#${thumbClipId})"
             href="${heroUris[i]}" preserveAspectRatio="xMidYMid slice"/>
    ` : `
      <defs>
        <clipPath id="${thumbClipId}">
          <rect x="${thumbX}" y="${thumbY}" width="${thumbSize}" height="${thumbSize}" rx="${thumbR}"/>
        </clipPath>
        <linearGradient id="phGrad${i}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${placeholderColor}" stop-opacity="0.55"/>
          <stop offset="1" stop-color="${placeholderColor}" stop-opacity="0.20"/>
        </linearGradient>
      </defs>
      <rect x="${thumbX}" y="${thumbY}" width="${thumbSize}" height="${thumbSize}" rx="${thumbR}"
            fill="url(#phGrad${i})" stroke="${BRAND.cardLine}" stroke-width="1"/>
      ${flagUri
        ? `<image x="${thumbX + (thumbSize - 80) / 2}" y="${thumbY + (thumbSize - 56) / 2 - 8}"
                 width="80" height="56" clip-path="url(#${thumbClipId})"
                 href="${flagUri}" preserveAspectRatio="xMidYMid meet" opacity="0.92"/>`
        : `<text x="${thumbX + thumbSize / 2}" y="${thumbY + thumbSize / 2 + 14}" text-anchor="middle"
                font-family="${FONT_FAMILY}" font-weight="800" font-size="40" letter-spacing="2"
                fill="${BRAND.cream}">${_esc((iso || 'na').toUpperCase())}</text>`}
    `;

    // ── Effect #7: vertical gold scan-line across hero thumb after landing.
    // Sweeps L→R once in the first 35% of the post-landing window. Clipped
    // to the thumb's clipPath so it stays inside the rounded rect.
    const scanPhase = _clamp(settledG / 0.35, 0, 1);
    const scanLineSvg = (settledG > 0 && settledG < 0.50) ? `
      <g clip-path="url(#${thumbClipId})">
        <rect x="${thumbX + thumbSize * scanPhase - 4}" y="${thumbY}"
              width="8" height="${thumbSize}"
              fill="${BRAND.gold}" opacity="${(0.50 * (1 - Math.abs(scanPhase * 2 - 1))).toFixed(3)}"/>
      </g>
    ` : '';

    // ── Right side: headline + meta row ──
    const textX = thumbX + thumbSize + 22;

    // ── Effect #13: headline appears word-by-word — full text, no truncation.
    //
    // The right column has ~766px of horizontal space (W_P - PAD_P*2 -
    // thumbSize - gaps). The old 30-char wrap was leaving most of that
    // empty + truncating real headlines (typical 80-130 chars) at line 2.
    // _fitTitle ladder: try 26px @ 48 chars × 3 lines (covers ~144 chars),
    // step down to 22px @ 56 × 3 (~168), then 19px @ 65 × 4 (~260).
    // Bar text area is 104px tall: 3 lines × 32px = 96 fits; 4 × 25 = 100 fits.
    const headlineFit = _fitTitle(art.headline || '(untitled)', [
      { size: 26, lineH: 32, charsPerLine: 48, maxLines: 3 },
      { size: 22, lineH: 28, charsPerLine: 56, maxLines: 3 },
      { size: 19, lineH: 25, charsPerLine: 65, maxLines: 4 },
    ]);
    const headlineLines = headlineFit.lines;
    const headlineSize  = headlineFit.size;
    const headlineLineH = headlineFit.lineH;
    const headlineY0    = barY + 44;
    const charW         = headlineSize * 0.55;

    // Adaptive word stagger — slow for short headlines (max 100ms each),
    // compressed for long ones so the last word still finishes typing
    // before the bar settles. lp budget for words is [0.30, 0.95].
    const totalWords  = headlineLines.reduce((a, l) => a + l.split(/\s+/).filter(Boolean).length, 0);
    const wordDur     = 0.25;
    const wordStagger = Math.min(0.10, Math.max(0.03,
                          (0.65 - wordDur) / Math.max(1, totalWords - 1)));

    let wordIdx = 0;
    const headlineSvg = headlineLines.map((line, j) => {
      const lineY = headlineY0 + j * headlineLineH;
      const words = line.split(/\s+/).filter(Boolean);
      let cumX = textX;
      return words.map(word => {
        const wordStart = 0.30 + wordIdx * wordStagger;
        const wordEnd   = wordStart + wordDur;
        const wordOpacity = _easeOutCubic(_windowed(lp, wordStart, wordEnd));
        const x = cumX;
        cumX += word.length * charW + charW; // approximate next word x
        wordIdx++;
        return `<text x="${x}" y="${lineY}"
                      font-family="${FONT_FAMILY}"
                      font-weight="700" font-size="${headlineSize}" letter-spacing="-0.4"
                      fill="${BRAND.cream}" opacity="${wordOpacity.toFixed(3)}">${_esc(word)}</text>`;
      }).join('\n');
    }).join('\n');

    // ── Meta row: small flag + ISO + source name + date ──
    const metaY = barY + barHeight - 22;
    const flagW = 28, flagH = 20;
    // ── Effect #15: source flag waves (skew-x sinusoidal) once visible. ──
    // 3 cycles over the clip, max ±6° skew. Pivots off flag center.
    const wavePhase = settledG > 0 ? Math.sin(settledG * Math.PI * 6) * 6 : 0;
    const flagCx = textX + flagW / 2;
    const flagCy = metaY - flagH / 2 + 2;
    const flagSvg = flagUri
      ? `<g transform="translate(${flagCx} ${flagCy}) skewX(${wavePhase.toFixed(2)}) translate(${-flagCx} ${-flagCy})">
           <image x="${textX}" y="${metaY - flagH + 2}" width="${flagW}" height="${flagH}" href="${flagUri}" preserveAspectRatio="xMidYMid slice"/>
         </g>`
      : `<rect x="${textX}" y="${metaY - flagH + 2}" width="${flagW}" height="${flagH}" rx="2" fill="${BRAND.cardLine}"/>`;

    // ── Effect #14: time meta count-up.
    // The relative time (e.g. "35M AGO") tweens its number from 0 → final
    // over the bar's post-land first 40%. ISO + source name stay constant.
    const isoTextX = textX + flagW + 8;
    const isoText = (iso || '').toUpperCase();
    const sourceText = (art.source_name || '').slice(0, 28);
    const fullDateText = _relativeTime(art.published_at);
    const timeMatch = fullDateText.match(/^(\d+)(.*)$/);
    let liveDateText = fullDateText;
    if (timeMatch && settledG < 0.40) {
      const finalN = parseInt(timeMatch[1], 10);
      const liveN = Math.max(0, Math.round(finalN * _easeOutCubic(_clamp(settledG / 0.40, 0, 1))));
      liveDateText = `${liveN}${timeMatch[2]}`;
    }
    const metaParts = [isoText, sourceText, liveDateText].filter(Boolean);
    const metaText = metaParts.join('  ·  ');
    const metaTextSvg = `
      <text x="${isoTextX}" y="${metaY}"
            font-family="${FONT_FAMILY}"
            font-weight="600" font-size="18" letter-spacing="1.2"
            fill="${BRAND.inkMute}">${_esc(metaText.toUpperCase())}</text>
    `;

    // ── Effect #1: left accent stripe pulses gold on landing.
    // Base stripe stays at 0.7 opacity; an overlay rect on top peaks
    // bright (0.95 + thicker glow blur) in a 200ms window around landing,
    // then fades back to invisible during settledG 0→0.4.
    const stripePulseOpacity = _easeOutCubic(_clamp(1 - settledG / 0.35, 0, 1));
    const accentStripe = `
      <rect x="${PAD_P}" y="${barY}" width="3" height="${barHeight}" rx="1.5"
            fill="${BRAND.gold}" opacity="0.7"/>
      <rect x="${PAD_P - 2}" y="${barY}" width="7" height="${barHeight}" rx="3.5"
            fill="${BRAND.gold}" opacity="${(stripePulseOpacity * 0.55).toFixed(3)}"/>
    `;

    // ── Bar bg + Effect #2 border glow + Effect #10 edge glow lines + Effect #9 gradient sweep ──
    // Bar background card
    const barBg = `
      <rect x="${PAD_P}" y="${barY}" width="${barW}" height="${barHeight}" rx="14"
            fill="${BRAND.card}" stroke="${BRAND.cardLine}" stroke-width="1"/>
    `;
    // #2 border glow flash on landing: peaks at lp~0.85 and fades through settledG 0→0.3
    const borderGlowOpacity = settledG > 0
      ? _easeOutCubic(_clamp(1 - settledG / 0.30, 0, 1)) * 0.60
      : _easeOutCubic(_clamp((lp - 0.65) / 0.20, 0, 1)) * 0.60;
    const borderGlow = `
      <rect x="${PAD_P}" y="${barY}" width="${barW}" height="${barHeight}" rx="14"
            fill="none" stroke="${BRAND.gold}" stroke-width="2.5"
            opacity="${borderGlowOpacity.toFixed(3)}"/>
    `;
    // #10 thin glow lines along top + bottom inner edges (always visible
    // once bar lands, gives the row a "lit-up" feel).
    const edgeGlowLines = `
      <rect x="${PAD_P + 8}" y="${barY + 1.5}" width="${barW - 16}" height="0.8"
            fill="${BRAND.gold}" opacity="0.32"/>
      <rect x="${PAD_P + 8}" y="${barY + barHeight - 2.3}" width="${barW - 16}" height="0.8"
            fill="${BRAND.gold}" opacity="0.18"/>
    `;
    // (Effect #9 gold gradient sweep removed — read as a "shimmer badge"
    // that competed with the bar's own content for attention. Border-glow
    // flash on landing handles the "lit-up" moment cleanly enough.)

    return `
      <g transform="translate(${slideX}, 0)" opacity="${lp.toFixed(3)}">
        ${barBg}
        ${edgeGlowLines}
        ${borderGlow}
        ${accentStripe}
        ${thumbSvg}
        ${scanLineSvg}
        ${headlineSvg}
        ${flagSvg}
        ${metaTextSvg}
      </g>
    `;
  }).join('\n');

  // Footer
  const footerSvg = `
    <text x="${PAD_P}" y="${H_P - 80}"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="30" letter-spacing="2"
          fill="${BRAND.goldSoft}">earth00.com</text>
  `;

  const bg = `
    <defs>
      <linearGradient id="bgGradA" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${BRAND.bgTop}"/>
        <stop offset="1" stop-color="${BRAND.bgBot}"/>
      </linearGradient>
    </defs>
    <rect width="${W_P}" height="${H_P}" fill="url(#bgGradA)"/>
  `;

  // Scan-line + border-trace on top of everything else (matches slide 1).
  const scanLineGlobalSvg = _renderScanLine({ p });
  const borderTraceSvg    = _renderBorderTrace({ p });

  // Scan-line is rendered BEFORE the bars so it passes behind them —
  // the gold line peeks out between rows, framing the bars instead of
  // covering their content. Border-trace stays on top.
  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W_P}" height="${H_P}" viewBox="0 0 ${W_P} ${H_P}">
      ${bg}
      ${haloSvg}
      ${iconBlock}
      ${eyebrowSvg}
      ${titleSvg}
      ${headerSvg}
      ${scanLineGlobalSvg}
      ${barsSvg}
      ${borderTraceSvg}
      ${footerSvg}
    </svg>
  `;
}

async function _renderLineSvg({ title, description, isos, category, articleCount, languageCount, countryCount, heroImageUrl, heroCatalogImageUrl }) {
  const heroSvg = await _heroPanel(heroImageUrl, heroCatalogImageUrl);
  const hasHero = !!heroSvg;

  // See _renderThreadSvg for full layout rationale.
  const lines = hasHero
    ? _wrapLines(title || 'Untitled timeline', 24, 2)
    : _wrapLines(title || 'Untitled timeline', 32, 2);
  const titleSize = hasHero ? 48 : 54;
  const titleLineH = hasHero ? 60 : 66;
  const titleSvg = lines.map((line, i) => {
    const y = 240 + i * titleLineH;
    return `<text x="56" y="${y}"
                  font-family="${FONT_FAMILY}"
                  font-weight="800" font-size="${titleSize}" letter-spacing="-2"
                  fill="${BRAND.cream}">${_esc(line)}</text>`;
  }).join('\n');

  const titleBottomY = 240 + (lines.length - 1) * titleLineH;
  const summarySvg = _summarySvg({ description, hasHero, y: titleBottomY + 28 });

  const chipsY = H - 130;
  const coverageText = _coverageLine({ articleCount, languageCount, countryCount });
  const coverageSvg = coverageText ? `
    <text x="56" y="${chipsY - 22}"
          font-family="${FONT_FAMILY}"
          font-weight="600" font-size="20" letter-spacing="1.4"
          fill="rgba(255,255,255,0.72)">${_esc(coverageText)}</text>
  ` : '';
  const chipsSvg = await _flagChips(isos, 56, chipsY);

  const catLabel = (category || 'Story').toUpperCase();
  // Category eyebrow bumped 13px → 19px (see thread renderer for
  // thumbnail-size rationale).
  const catSvg = `
    <text x="56" y="180"
          font-family="${FONT_FAMILY}"
          font-weight="700" font-size="19" letter-spacing="3"
          fill="${BRAND.gold}">${_esc(catLabel)} · STORY LINE</text>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${_background()}
      ${heroSvg}
      ${_chrome()}
      ${catSvg}
      ${titleSvg}
      ${summarySvg}
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
  // Read the SVG's declared width so portrait (1080) and landscape
  // (1200) templates both render at their intrinsic size. Fallback to
  // the landscape default if the SVG omits a width attribute.
  const widthMatch = svg.match(/<svg[^>]+\swidth="(\d+)"/);
  const renderWidth = widthMatch ? parseInt(widthMatch[1], 10) : W;
  // CRITICAL: loadSystemFonts rescans the OS font directory on EVERY
  // call (resvg-js doesn't cache the font db across Resvg instances).
  // On Mac with /Library/Fonts populated, that's ~2.5s per render —
  // fine for the once-per-share still images, fatal for the 90-frame
  // animated cards. We only enable it when there are NO bundled
  // fonts at all (cold dev startup with empty fonts/), otherwise
  // resvg uses just the bundled Inter family and renders in ~50ms.
  const useSystemFonts = _fontFiles.length === 0;
  const resvg = new Resvg(svg, {
    background: BRAND.bgTop,
    fitTo: { mode: 'width', value: renderWidth },
    font: {
      loadSystemFonts: useSystemFonts,
      defaultFontFamily: 'Inter',
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
    case 'thread':           svg = await _renderThreadSvg(entity);         break;
    case 'thread-portrait':  svg = await _renderThreadPortraitSvg(entity); break;
    case 'thread-coverage':  svg = await _renderThreadCoveragePieSvg(entity); break;
    case 'thread-articles':  svg = await _renderThreadArticlesSvg(entity); break;
    case 'line':             svg = await _renderLineSvg(entity);           break;
    case 'heatmap':          svg = await _renderHeatmapSvg(entity);        break;
    case 'flows':            svg = await _renderFlowsSvg(entity);          break;
    default:                 throw new Error(`unknown share kind: ${entity.kind}`);
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

// Frame-mode render: produce a PNG buffer for the given entity at a
// specific animation `progress` (0..1). Bypasses the LRU since every
// frame is a unique image. Used by animatedCardRenderer.js to build
// MP4 frame sequences for the IG carousel slides.
async function generateFrame(entity, progress) {
  const ent = { ...entity, animation: { progress } };
  let svg;
  switch (ent.kind) {
    case 'thread-portrait':  svg = await _renderThreadPortraitSvg(ent);    break;
    case 'thread-coverage':  svg = await _renderThreadCoveragePieSvg(ent); break;
    case 'thread-articles':  svg = await _renderThreadArticlesSvg(ent);    break;
    default: throw new Error(`generateFrame: kind not animated: ${ent.kind}`);
  }
  return _toPng(svg);
}

module.exports = { generate, generateFrame, bustCache, BRAND, W, H, W_P, H_P };
