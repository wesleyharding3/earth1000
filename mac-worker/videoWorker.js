#!/usr/bin/env node
/**
 * videoWorker.js — Mac-side opportunistic video renderer.
 *
 * Architecture: Render has no GPU, so the production globe (heavy
 * WebGL with custom shaders + multiple contexts) can't be reliably
 * rendered headlessly on the server. This worker runs on the admin's
 * Mac, which has a real GPU. Polls Render's /api/video-jobs/pending
 * endpoint every POLL_INTERVAL ms; when a job is found, opens
 * earth00.com/?thread=X in headless Puppeteer (real Mac Chromium),
 * records the cinematic globe-flyby via __shareGlobeClip, POSTs the
 * resulting MP4 back to /api/video-jobs/:thread_id/result.
 *
 * Runs as a launchd agent (com.earth00.videoworker.plist) — starts at
 * login, auto-restarts on crash, runs invisibly. While the Mac is
 * asleep launchd suspends the process; on wake it resumes polling.
 *
 * Config (~/.earth00-worker.json):
 *   {
 *     "renderHost": "https://earth-wjr6.onrender.com",
 *     "appHost":    "https://earth00.com",
 *     "token":      "<long random string matching VIDEO_WORKER_TOKEN on Render>",
 *     "dumpDir":    "<absolute path or ~/path — local mirror of every carousel/reel
 *                    slot the picker cron produces; default is ~/Desktop/earth00/carousel_dumps;
 *                    pass an empty string to disable>"
 *   }
 *
 * The worker writes every freshly-rendered arc.mp4 to <dumpDir>/<title>/arc.mp4
 * directly from the buffer, and every ~10 polls calls the server's
 * /api/video-jobs/dump-targets endpoint to pull any portrait / pie /
 * articles / reel slots the picker cron's pre-warm pass has produced.
 * Result: a tiktok-ready local copy of every carousel + reel without
 * re-rendering, organized by sanitized thread title.
 *
 * Logs to ~/Library/Logs/earth00-worker.log (configured by launchd plist).
 */

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.earth00-worker.json');
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`[worker] FATAL: cannot read ${CONFIG_PATH}: ${err.message}`);
  console.error(`[worker] expected JSON with { renderHost, appHost, token }`);
  process.exit(1);
}
const RENDER_HOST = String(CONFIG.renderHost || '').replace(/\/+$/, '');
const APP_HOST    = String(CONFIG.appHost    || '').replace(/\/+$/, '');
const TOKEN       = String(CONFIG.token      || '');
if (!RENDER_HOST || !APP_HOST || !TOKEN) {
  console.error('[worker] FATAL: config missing renderHost / appHost / token');
  process.exit(1);
}
// Local dump dir — when set, every carousel/reel slot the picker cron
// produces gets mirrored to <DUMP_DIR>/<sanitized-title>/<slot>.mp4 so
// the user can manually post the same renders to TikTok / Mastodon /
// wherever else, without re-rendering. Default points at the project's
// canonical carousel_dumps folder; set to '' or null in config to skip.
const DUMP_DIR = (() => {
  const v = CONFIG.dumpDir;
  if (v === '' || v === null) return '';                    // explicit disable
  if (typeof v === 'string' && v.trim()) return path.resolve(v.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), 'Desktop', 'earth00', 'carousel_dumps');
})();
const SLOTS = [
  { key: 'portrait', file: 'portrait.mp4' },
  { key: 'arc',      file: 'arc.mp4'      },
  { key: 'pie',      file: 'pie.mp4'      },
  { key: 'articles', file: 'articles.mp4' },
  { key: 'reel',     file: 'reel.mp4'     },
];
function sanitizeTitle(name) {
  return String(name || 'untitled')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120) || 'untitled';
}

const POLL_INTERVAL_MS = 60_000;     // poll every minute
// 15s clip — TWO full revolutions in a figure-8 pattern. Yaw goes
// from 0 → 4π linearly while pitch oscillates sin(2π·p) × 0.7 rad
// (~40°), centering the camera over the northern hemisphere during
// the first rotation and the southern during the second. Net effect:
// no country gets stuck at the edge of frame regardless of latitude.
// Math is in index.html → __renderClipFrame.
const DURATION_MS      = 15_000;
const PAGE_TIMEOUT_MS  = 60_000;
const RENDER_TIMEOUT_MS = 600_000;   // hard ceiling per render attempt.
                                     // 450 frames × ~530ms/frame = ~240s
                                     // worker loop + ~30s server ffmpeg
                                     // normalize. 360s gives headroom
                                     // for CDN-cold first frames.

const log = (m) => console.log(`[worker ${new Date().toISOString()}] ${m}`);
const warn = (m) => console.warn(`[worker ${new Date().toISOString()}] ${m}`);

// ── Render API helpers ─────────────────────────────────────────────────
async function fetchPending() {
  const res = await fetch(`${RENDER_HOST}/api/video-jobs/pending?token=${encodeURIComponent(TOKEN)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pending HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function uploadResult(threadId, mp4Buffer) {
  const res = await fetch(`${RENDER_HOST}/api/video-jobs/${threadId}/result?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: mp4Buffer,
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

async function reportSkip(threadId, reason) {
  try {
    await fetch(`${RENDER_HOST}/api/video-jobs/${threadId}/skip?token=${encodeURIComponent(TOKEN)}&reason=${encodeURIComponent(reason)}`, {
      method: 'POST',
    });
  } catch (_) { /* best-effort */ }
}

// ── Briefing-segment render API helpers ──────────────────────────────
async function fetchBriefingPending() {
  const url = `${RENDER_HOST}/api/video-jobs/briefings/pending?token=${encodeURIComponent(TOKEN)}&limit=3`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`briefings/pending HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function reportBriefingComplete(jobId, bytesOut) {
  const res = await fetch(`${RENDER_HOST}/api/video-jobs/briefings/${jobId}/complete?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes_out: bytesOut }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`briefings/complete HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function reportBriefingSkip(jobId, reason) {
  try {
    await fetch(`${RENDER_HOST}/api/video-jobs/briefings/${jobId}/skip?token=${encodeURIComponent(TOKEN)}&reason=${encodeURIComponent(reason)}`, {
      method: 'POST',
    });
  } catch (_) { /* best-effort */ }
}

// ── Local-dump helpers ────────────────────────────────────────────────
// Mirror every MP4 slot the picker cron produces to the user's project
// folder so they can manually re-post to TikTok / Mastodon / etc.
async function ensureDumpFolder(title, threadId) {
  if (!DUMP_DIR) return null;
  await fs.promises.mkdir(DUMP_DIR, { recursive: true });
  const base = sanitizeTitle(title || `thread-${threadId}`);
  const dir  = path.join(DUMP_DIR, base);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// Write the just-rendered arc.mp4 directly from the in-memory buffer.
// Free — we already have the bytes from the Puppeteer pass.
async function dumpArcLocally(threadId, title, mp4Buffer) {
  if (!DUMP_DIR) return;
  try {
    const dir = await ensureDumpFolder(title, threadId);
    if (!dir) return;
    await fs.promises.writeFile(path.join(dir, 'arc.mp4'), mp4Buffer);
    await fs.promises.writeFile(path.join(dir, 'meta.txt'),
      `thread_id:  ${threadId}\n` +
      `title:      ${title || ''}\n` +
      `arc_bytes:  ${mp4Buffer.length}\n` +
      `arc_saved:  ${new Date().toISOString()}\n`);
    log(`  ↳ dumped arc.mp4 → ${dir}`);
  } catch (err) {
    warn(`  dump arc failed: ${err.message}`);
  }
}

async function fetchDumpTargets() {
  const res = await fetch(`${RENDER_HOST}/api/video-jobs/dump-targets?token=${encodeURIComponent(TOKEN)}&days=30`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dump-targets HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

async function downloadShareMp4(threadId, slotFile) {
  // share endpoints are public — no token needed. They serve from DB
  // cache; on cache miss the server renders + caches before responding,
  // but every slot we're fetching has slots[<slot>]=true (verified before
  // we get here), so the DB row already has bytes.
  const url = `${APP_HOST}/share/thread/${threadId}/${slotFile}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${slotFile}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`undersized ${slotFile} (${buf.length} bytes)`);
  return buf;
}

// Locally stitch the four carousel cards into a single 9:16 1080×1920
// reel.mp4 — same role as the server's /share/thread/:id/reel.mp4
// endpoint, but done on the Mac so we sidestep Render's 60s gateway
// timeout. Each card is scaled-to-fit + black-padded to a uniform
// 1080×1920 canvas (portrait/pie/articles are 4:5 1080×1350 natively;
// arc is already 9:16 1080×1920), then concat-filtered with audio.
// Result is a TikTok-ready uniform-aspect reel even though the input
// cards have mixed aspects.
async function stitchCarouselToReelLocally(threadId, dir) {
  const { spawn } = require('child_process');
  const inputs = ['portrait.mp4', 'arc.mp4', 'pie.mp4', 'articles.mp4'];
  for (const f of inputs) {
    const p = path.join(dir, f);
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat || stat.size < 1000) {
      throw new Error(`missing input ${f} for local reel stitch`);
    }
  }
  const out = path.join(dir, 'reel.mp4');
  // Each [vN] is scaled to fit inside 1080×1920 keeping aspect, then
  // padded with black to the exact 1080×1920 canvas (centered), then
  // SAR forced to 1 so concat doesn't complain about mismatched pixel
  // ratios. Audio is straight passthrough (each card has its own AAC
  // track). The concat filter ties video+audio for each of the four
  // segments and outputs one [outv][outa] pair.
  const filter = inputs.map((_, i) => (
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v${i}]`
  )).join(';') + ';' +
    inputs.map((_, i) => `[v${i}][${i}:a]`).join('') +
    `concat=n=${inputs.length}:v=1:a=1[outv][outa]`;
  const args = [
    '-loglevel', 'error',
    '-y',
    ...inputs.flatMap(f => ['-i', path.join(dir, f)]),
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    out,
  ];
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg(reel-stitch) exit ${code}: ${stderr.slice(0, 500)}`)));
    ff.on('error', reject);
  });
  const stat = await fs.promises.stat(out);
  return stat.size;
}

// Walk the dump-targets list and download any slot that the DB has but
// local disk doesn't. Idempotent per slot — skip-if-exists keeps the
// scan cheap on subsequent polls.
async function syncDumpsFromServer() {
  if (!DUMP_DIR) return;
  let targets;
  try {
    targets = await fetchDumpTargets();
  } catch (err) {
    warn(`dump-targets fetch failed: ${err.message}`);
    return;
  }
  if (!targets.length) return;
  let pulled = 0;
  let skipped = 0;
  let reelsTriggered = 0;
  for (const t of targets) {
    if (!_running) break;
    const dir = await ensureDumpFolder(t.title, t.thread_id);
    if (!dir) continue;
    // First pass: download every slot the DB row already has (free —
    // serves from BYTEA cache).
    for (const slot of SLOTS) {
      if (!t.slots[slot.key]) continue;             // not yet rendered server-side
      const dest = path.join(dir, slot.file);
      try {
        const stat = await fs.promises.stat(dest).catch(() => null);
        if (stat && stat.size > 1000) { skipped++; continue; }
        const buf = await downloadShareMp4(t.thread_id, slot.file);
        await fs.promises.writeFile(dest, buf);
        pulled++;
        log(`  ↳ pulled ${slot.file} for thread=${t.thread_id} "${(t.title || '').slice(0, 40)}" (${buf.length} bytes)`);
      } catch (err) {
        warn(`  ↳ ${slot.file} thread=${t.thread_id}: ${err.message}`);
      }
    }
    // Second pass: if we have all four carousel cards locally but no
    // reel.mp4 yet, ffmpeg-stitch them into a uniform 9:16 reel right
    // here on the Mac. We tried hitting /share/thread/:id/reel.mp4 to
    // let the server do this, but the cold render exceeds Render's
    // 60s gateway timeout (4 cards × ~15s + concat ≈ 70-80s). Doing
    // it locally is faster (no network), uses the user's hardware,
    // and never times out. If we DO see slots.reel=true (reel-mode
    // post that picker cron pre-warmed), we still prefer to pull from
    // server since that copy is exactly what was published.
    const reelDest = path.join(dir, 'reel.mp4');
    const reelStat = await fs.promises.stat(reelDest).catch(() => null);
    const haveAllCarouselCards =
      (await fs.promises.stat(path.join(dir, 'portrait.mp4')).catch(() => null))?.size > 1000 &&
      (await fs.promises.stat(path.join(dir, 'arc.mp4')).catch(() => null))?.size > 1000 &&
      (await fs.promises.stat(path.join(dir, 'pie.mp4')).catch(() => null))?.size > 1000 &&
      (await fs.promises.stat(path.join(dir, 'articles.mp4')).catch(() => null))?.size > 1000;
    if (!reelStat || reelStat.size < 1000) {
      if (t.slots.reel) {
        try {
          const buf = await downloadShareMp4(t.thread_id, 'reel.mp4');
          await fs.promises.writeFile(reelDest, buf);
          pulled++;
          log(`  ↳ pulled reel.mp4 (server cache) for thread=${t.thread_id} (${buf.length} bytes)`);
        } catch (err) {
          warn(`  ↳ reel.mp4 thread=${t.thread_id}: ${err.message}`);
        }
      } else if (haveAllCarouselCards) {
        try {
          const t0 = Date.now();
          const bytes = await stitchCarouselToReelLocally(t.thread_id, dir);
          reelsTriggered++;
          log(`  ↳ stitched reel.mp4 locally for thread=${t.thread_id} "${(t.title || '').slice(0, 40)}" (${bytes} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (err) {
          warn(`  ↳ reel-stitch thread=${t.thread_id}: ${err.message}`);
        }
      }
    }
  }
  if (pulled || skipped || reelsTriggered) {
    log(`dump sync: pulled ${pulled}, skipped ${skipped} (already local), triggered ${reelsTriggered} on-demand reel render(s)`);
  }
}

// ── Video render (Mac-side Puppeteer) ──────────────────────────────────
async function renderVideo(job) {
  const puppeteer = require('puppeteer');
  // Headless mode: tried non-headless (real Chrome window, positioned
  // off-screen at -4000,-4000) hoping the native display compositor
  // would unlock 60Hz, but macOS marked the off-screen window as
  // OCCLUDED and applied the same composite-rate throttle (19.7fps vs
  // headless's 25.8fps with the RAF override below — strictly worse).
  // Headless + visibility spoof + RAF override is our best perf;
  // smoothness is finalized by a server-side ffmpeg pass that
  // normalizes frame timing to a constant 30fps (see
  // /api/video-jobs/:thread_id/result in server.js).
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,GlobalMediaControls',
    ],
  });
  const browserLogs = [];
  // Hoisted out of the try block so the finally{} can call
  // __teardownClipRecording on it regardless of where the try fails.
  let page;
  try {
    page = await browser.newPage();
    page.on('console',       msg => browserLogs.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`));
    page.on('pageerror',     err => browserLogs.push(`[pageerror] ${err.message}`));
    page.on('requestfailed', req => browserLogs.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`));

    // ── Force the page to report itself as VISIBLE.
    //
    // Root cause of the choppy ~7fps capture (vs. the smooth in-app
    // share-button output): Chromium's Page Visibility API reports the
    // page as `visibilityState='hidden'` in headless mode (and even
    // some background-tab cases), and the renderer responsively
    // throttles requestAnimationFrame down to ~1Hz–10Hz to save CPU.
    // That's invisible to the page's JS — RAF callbacks still fire,
    // just much less often than the 60fps we expect.
    //
    // The `--disable-background-timer-throttling` flag only governs
    // setTimeout/setInterval, NOT rAF. There's no Chrome flag that
    // disables rAF throttling cleanly. The reliable fix is to override
    // document.visibilityState + document.hidden BEFORE any of the
    // app's JS runs, and re-dispatch the visibilitychange event so
    // anything listening recomputes (in our case, Chromium's own
    // throttling logic checks visibilityState directly per frame).
    //
    // evaluateOnNewDocument injects this into EVERY page (incl. iframes
    // and subsequent navigations) before any user-script execution.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => false });
      Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'webkitHidden',          { configurable: true, get: () => false });
      // Some throttlers check window.onblur — keep claiming focus too.
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));

      // ── Force-tick requestAnimationFrame at 60Hz via setInterval ──
      //
      // The visibility spoof above brought capture FPS from ~7 → ~20 by
      // disabling the main throttler, but Chromium has OTHER RAF
      // slowdown paths (intersection observer occlusion, idle-time
      // throttling, GPU compositing rate caps) that we can't disable
      // cleanly. The reliable workaround: replace native RAF with a
      // setInterval-driven ticker that fires callbacks at 60Hz
      // regardless of Chrome's compositor decisions.
      //
      // We disabled background-timer-throttling at the CLI flag level,
      // so setInterval runs at a true 16.6ms cadence. The native RAF
      // is still used as a fallback for vsync alignment when the page
      // is visible, but our setInterval guarantees a minimum rate.
      //
      // Three.js and the recording paint loop both use requestAnimationFrame
      // (we checked — no setTimeout fallback) so this monkey-patch
      // covers both the globe scene render and the captureStream paint.
      const _rafQueue = [];
      const _origRAF  = window.requestAnimationFrame.bind(window);
      let _rafIdCounter = 1;
      window.requestAnimationFrame = function(cb) {
        const id = _rafIdCounter++;
        _rafQueue.push({ id, cb });
        return id;
      };
      window.cancelAnimationFrame = function(id) {
        const idx = _rafQueue.findIndex(e => e.id === id);
        if (idx >= 0) _rafQueue.splice(idx, 1);
      };
      setInterval(() => {
        if (!_rafQueue.length) return;
        const queue = _rafQueue.splice(0, _rafQueue.length);
        const t = performance.now();
        for (const { cb } of queue) {
          try { cb(t); } catch (_) { /* swallow per-RAF errors so the ticker keeps firing */ }
        }
      }, 1000 / 60);
    });

    // Viewport matches the Reel recording canvas (1080×1920, 9:16) so
    // the WebGL globe+stars output fills the rec frame edge-to-edge —
    // starfield spans the entire back of the frame instead of being
    // letterboxed. Earlier we'd flipped to 4:5 (1080×1350) for the IG
    // carousel slot, but the reel pipeline now stitches arc.mp4 into a
    // 9:16 stack with the cards, so we want the arc rendered natively
    // at 9:16 — no concat-time letterbox during the middle 15s.
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    // Force-foreground the tab so anything that uses tab-focus state
    // (not just visibility) also reports as active.
    try { await page.bringToFront(); } catch (_) { /* best-effort */ }

    const url = `${APP_HOST}/?thread=${job.thread_id}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    // Wait for the production globe + the flow-arc trigger.
    //   __shareGlobeClip — what we call to record
    //   showThreadFlows  — the "Show on Globe" entry point that
    //                      actually mounts arcs + city lights for
    //                      a thread (NOT __openThread, which only
    //                      opens the side panel without arcs)
    await page.waitForFunction(() => {
      return typeof window.__renderClipFrame === 'function'
          && typeof window.__setupClipRecording === 'function'
          && typeof window.showThreadFlows === 'function'
          && !!window.__renderer;
    }, { timeout: PAGE_TIMEOUT_MS });

    // Trigger the FULL flow-arc visualization. showThreadFlows fetches
    // articles, mounts arcs on the globe, lights up primary nations,
    // etc. The function's own Promise resolves before all of that is
    // visible on the globe though — articles are fetched async, arcs
    // get queued for the next RAF tick.
    await page.evaluate(async (id) => {
      try { await window.showThreadFlows(id, null); }
      catch (e) { console.warn('[worker] showThreadFlows:', e.message); }
    }, job.thread_id);

    // Poll until arcs are ACTUALLY mounted on the globe. Earlier the
    // worker just slept 6s after showThreadFlows and hoped — when the
    // articles fetch was slow, the recording started before arcs were
    // visible. __replayArcAnimations() returns the current arc count
    // (closure-local arcObjects.length), so we can use it as a proxy.
    const arcCountInScene = await page.evaluate(async () => {
      const MAX_WAIT_MS  = 20000;
      const POLL_MS      = 500;
      const t0 = Date.now();
      let count = 0;
      while (Date.now() - t0 < MAX_WAIT_MS) {
        try {
          count = typeof window.__replayArcAnimations === 'function'
            ? window.__replayArcAnimations()
            : 0;
        } catch (_) { count = 0; }
        if (count > 0) return count;
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      return 0;
    });
    log(`  arcs in scene: ${arcCountInScene}`);

    // Wait for the Blue Marble satellite texture to actually finish
    // loading. Previously this was a fixed 6s sleep but heavier threads
    // (e.g. Taiwan w/ 875 articles) keep the page busier mounting arcs,
    // delaying the async NASA-CDN texture load past 6s — first ~10
    // frames captured the globe with only country polygons visible
    // (untextured surface mesh = transparent), causing the user-reported
    // "globe pops in" flicker on that thread specifically.
    //
    // index.html sets window.__blueMarbleLoaded = true in the texture
    // load callback. 15s ceiling guards against CDN failures so the
    // worker never hangs — on timeout we proceed anyway (the globe
    // falls back to the bundled low-res baseline texture, still better
    // than not rendering at all).
    try {
      await page.waitForFunction(() => window.__blueMarbleLoaded === true, { timeout: 15000 });
      log('  Blue Marble texture ready');
    } catch (_) {
      warn('  Blue Marble timeout (>15s) — proceeding with fallback texture');
    }
    // Small additional settle for any per-thread state still resolving
    // after the texture lands (arc opacity easings, etc).
    await new Promise(r => setTimeout(r, 1500));

    // ── Deterministic frame-by-frame rendering ──
    //
    // Replaces the realtime __shareGlobeClip + captureStream + MediaRecorder
    // pipeline because Puppeteer headless caps framebuffer commits to
    // ~25 Hz internally — no amount of RAF override / visibility spoof
    // / non-headless gets us to 60fps with even timing for a complex
    // WebGL scene. The deterministic loop bypasses all of that: we
    // explicitly position the globe + arcs at progress p, render once
    // synchronously, screenshot the page's recording canvas, repeat
    // for every frame. The resulting MP4 is guaranteed silk-smooth
    // because every frame's content is at the mathematically correct
    // position with no timing jitter.

    // Configure arc draw-in timings (no live animation — these get
    // sampled per-frame inside __renderClipFrame). Same windows as
    // before so each arc draws in over ~2-3s of clip time.
    await page.evaluate(() => {
      if (typeof window.__replayArcAnimations === 'function') {
        window.__replayArcAnimations({
          drawInDurationBase:  2.0,
          drawInDurationRange: 1.0,    // → 2.0-3.0s per arc
          drawInDelayMax:      2.5,    // → up to 2.5s stagger
        });
      }
    });

    // Setup recording canvas + overlay painter (preloads icon + flag
    // images, returns once they're cached). spinSeconds defines the
    // clip's wallclock duration that arc draw-in times are relative to.
    const spinSeconds = DURATION_MS / 1000;
    await page.evaluate(async (opts) => {
      return await window.__setupClipRecording({
        spinSeconds: opts.spinSeconds,
        // Reel-mode canvas: 9:16 (1080×1920) matches the viewport,
        // so the renderer's domElement fills the rec frame edge-to-
        // edge with no letterboxing.
        width:       opts.width,
        height:      opts.height,
        // Tighter camera multipliers for the taller canvas — the
        // 1.20× → 1.45× defaults are tuned for 4:5 where the globe
        // already fills the shorter axis. At 9:16 the same zoom
        // leaves a small globe in a tall frame. 0.95× → 1.15× pulls
        // the camera in so the globe owns the visual center.
        zoomStart:   opts.zoomStart,
        zoomEnd:     opts.zoomEnd,
        overlay: {
          title:     opts.title || 'Story',
          subtitle:  opts.subtitle || 'Storyline',
          flagIsos:  opts.flagIsos  || [],
          flagNames: opts.flagNames || [],
        },
      });
    }, {
      spinSeconds,
      width:     1080,
      height:    1920,
      zoomStart: 0.95,
      zoomEnd:   1.15,
      title:     job.title,
      subtitle:  job.subtitle,
      flagIsos:  job.flag_isos,
      flagNames: job.flag_names,
    });

    // ── Spawn ffmpeg + frame loop ──
    const TARGET_FPS   = 30;
    const FRAME_COUNT  = TARGET_FPS * spinSeconds;
    const tmpDir       = require('os').tmpdir();
    const tmpOut       = path.join(tmpDir, `arc-det-${process.pid}-${Date.now()}.mp4`);
    const ffmpegPath   = require('@ffmpeg-installer/ffmpeg').path;
    const { spawn }    = require('child_process');
    // Audio: same portrait.mp3 loop the server-side card renderer uses,
    // so the whole 4-slide IG carousel shares one unified motif. The 4s
    // loop plays ~3.75 times across the arc's 15s duration; the final
    // cycle gets cut mid-phrase at 15s. Masking that with a 0.5s
    // fade-out so the truncation isn't audible.
    //
    // File ships as a sibling of videoWorker.js (install.sh copies it
    // from the repo's audio/carousel/portrait.mp3 to the install dir).
    const audioPath = path.join(__dirname, 'portrait.mp3');
    const ffmpeg = spawn(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(TARGET_FPS), '-i', 'pipe:0',
      '-stream_loop', '-1', '-i', audioPath,
      '-map', '0:v', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
      '-r', String(TARGET_FPS), '-t', String(spinSeconds),
      '-af', 'afade=t=out:st=14.5:d=0.5',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'mp4', tmpOut,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    const ffStderr = [];
    ffmpeg.stderr.on('data', c => ffStderr.push(c));
    let ffmpegError = null;
    ffmpeg.stdin.on('error', err => { ffmpegError = err; });
    const ffmpegDone = new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(ffStderr).toString().slice(0, 400)}`));
      });
      ffmpeg.on('error', reject);
    });

    // Hard timeout on the whole loop so a stuck page doesn't hang us.
    const loopDeadline = Date.now() + RENDER_TIMEOUT_MS;
    for (let i = 0; i < FRAME_COUNT; i++) {
      if (Date.now() > loopDeadline) {
        try { ffmpeg.stdin.end(); } catch (_) {}
        throw new Error(`render hit RENDER_TIMEOUT_MS at frame ${i}/${FRAME_COUNT}`);
      }
      if (ffmpegError) {
        throw new Error(`ffmpeg stdin closed early: ${ffmpegError.message}`);
      }
      const progress = i / (FRAME_COUNT - 1);
      const dataB64 = await page.evaluate(p => window.__renderClipFrame(p), progress);
      if (!dataB64) {
        try { ffmpeg.stdin.end(); } catch (_) {}
        throw new Error(`__renderClipFrame returned no data at frame ${i}`);
      }
      const png = Buffer.from(dataB64, 'base64');
      if (!ffmpeg.stdin.write(png)) {
        await new Promise(r => ffmpeg.stdin.once('drain', r));
      }
    }
    try { ffmpeg.stdin.end(); } catch (_) {}
    await ffmpegDone;

    const fs2 = require('fs');
    const mp4 = await fs2.promises.readFile(tmpOut);
    try { await fs2.promises.unlink(tmpOut); } catch (_) {}
    log(`  deterministic render: ${FRAME_COUNT} frames → ${mp4.length} bytes`);
    return mp4;
  } finally {
    // Always un-pause the page's animate() loop, even on error, so
    // the page can recover its normal rendering state if reused.
    if (page) {
      try { await page.evaluate(() => window.__teardownClipRecording && window.__teardownClipRecording()); } catch (_) {}
    }
    await browser.close().catch(() => {});
  }
}

// ── Briefing-segment renderer ──────────────────────────────────────────
// Records ONE briefing segment as a 1080×1920 portrait MP4 with audio
// for content production. The pipeline:
//
//   1. Launch Puppeteer at 1080×1920 (portrait), open
//      <APP_HOST>/?episode=<id>&captureSeg=<idx>. The page's
//      _maybeRunCaptureMode bootstrap fetches the episode, jumps to
//      that segment, and flips window.__briefingCaptureReady=true.
//   2. Start CDP Page.startScreencast → stream JPEG frames at 30fps.
//   3. Each frame is acked and piped to an ffmpeg image2pipe → MP4
//      (silent video).
//   4. Poll for window.__briefingCaptureSegmentDone (set by
//      _onSegmentEnded in capture mode) — bounded by the segment's
//      audio_ms + a 5s safety margin.
//   5. Stop screencast, close ffmpeg stdin, wait for the video MP4.
//   6. Fetch the segment audio from /api/briefing/audio/<id>/<seg>.
//   7. ffmpeg mux video + audio → final 9:16 MP4 → write to
//      <dumpDir>/briefings/<episode-date>/seg-<idx>.mp4.
//
// Local-only: nothing uploaded to server. POST .../complete just flips
// the queue row's status so the next worker poll skips it.
const BRIEFING_CAPTURE_W = 1080;
const BRIEFING_CAPTURE_H = 1920;
// Bumped 30 → 60 for noticeably smoother globe choreography. Chrome's
// headless screencast delivers up to ~60fps when GPU rasterization is
// enabled (already on via --enable-gpu-rasterization); ffmpeg fills any
// gaps via -vsync cfr so the output is always exactly 60fps.
const BRIEFING_FPS = 60;
// Soft music bed mixed under the narration. Path resolves relative to
// the installed worker dir (install.sh copies the file from the project
// root). Volume is well below the narration so it reads as ambient.
const BRIEFING_MUSIC_PATH = path.join(__dirname, 'Morse Room Signal.mp3');
const BRIEFING_MUSIC_VOLUME = 0.12;

async function renderBriefingSegment(job) {
  const puppeteer = require('puppeteer');
  const { spawn } = require('child_process');
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: BRIEFING_CAPTURE_W, height: BRIEFING_CAPTURE_H },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      // Unthrottle the compositor. Without these flags Chrome caps its
      // render rate at the display refresh and headless screencast often
      // delivers <10 fps under WebGL load; with them headless can push
      // 30-50 fps which is what we actually want for smooth briefing
      // playback.
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      `--window-size=${BRIEFING_CAPTURE_W},${BRIEFING_CAPTURE_H}`,
    ],
  });
  const t0 = Date.now();
  let page, client;
  const runId = `${job.job_id}-${Date.now()}`;
  const framesDir = path.join(os.tmpdir(), `briefing-${runId}-frames`);
  const concatTxt = path.join(os.tmpdir(), `briefing-${runId}-concat.txt`);
  const tmpVid   = path.join(os.tmpdir(), `briefing-${runId}-vid.mp4`);
  const tmpAudio = path.join(os.tmpdir(), `briefing-${runId}-aud.mp3`);
  const tmpOut   = path.join(os.tmpdir(), `briefing-${runId}-out.mp4`);
  await fs.promises.mkdir(framesDir, { recursive: true });
  // Per-frame {ts, path} record; ts is the CDP metadata.timestamp
  // (seconds since epoch) of the frame's wall-clock capture time.
  // We need the real timing because Chrome's screencast delivery rate
  // is highly variable in headless (anywhere from 7 fps to 60 fps)
  // and ffmpeg's image2pipe assumes a fixed -framerate, which makes
  // any output speed-up bug almost guaranteed unless we use timestamps.
  const frames = [];
  try {
    page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => false });
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      // Pre-seed all "first-launch" localStorage flags so the page
      // doesn't sit on welcome / intro / tutorial overlays instead of
      // rendering the briefing. Puppeteer has a fresh localStorage per
      // session — without these seeds the page treats every capture
      // run as a brand-new visit and shows the welcome card, blocking
      // openBriefing entirely (which is why the first batch of segment
      // MP4s only had the welcome splash + voiceover).
      try {
        localStorage.setItem('__earthIntroSeen', '1');
        localStorage.setItem('earth00:tutorialSeen', '1');
        localStorage.setItem('earth00:audioMuted', '0');
      } catch (_) {}
    });
    // captureToken is consumed by _maybeRunCaptureMode in index.html
    // and stamped into window.__authToken so the page's in-app audio
    // URL builders (every one of which appends ?at=<__authToken>) pass
    // the server's worker-token bypass. Without this the audio fetches
    // 401, the page falls into silent-fallback mode, and the screencast
    // stops at the silent-fallback's estDur instead of the full segment.
    //
    // _bust busts CDN cache so a stale earth00.com HTML doesn't ship
    // an older version of the page without window.__captureBriefingClip.
    const bust = Date.now().toString(36);
    const url = `${APP_HOST}/?episode=${job.episode_id}&captureSeg=${job.segment_idx}&captureToken=${encodeURIComponent(TOKEN)}&_bust=${bust}`;
    log(`  ↦ ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });

    // Wait for capture-mode bootstrap: __briefingCaptureReady true OR
    // __briefingCaptureError set. The page resolves one of these within
    // ~5-15s (episode fetch + openBriefing + first audio canplay).
    const waitReadyMs = 60_000;
    const readyDeadline = Date.now() + waitReadyMs;
    let lastErr = null;
    while (Date.now() < readyDeadline) {
      const state = await page.evaluate(() => ({
        ready: !!window.__briefingCaptureReady,
        err:   window.__briefingCaptureError || null,
      })).catch(() => ({ ready: false, err: null }));
      if (state.err) throw new Error(`page: ${state.err}`);
      if (state.ready) { lastErr = null; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    const readyState = await page.evaluate(() => ({
      ready: !!window.__briefingCaptureReady,
      err:   window.__briefingCaptureError || null,
    }));
    if (!readyState.ready) {
      throw new Error('capture mode did not become ready within 60s' + (readyState.err ? ` (${readyState.err})` : ''));
    }

    // Deterministic frame-by-frame capture. The page's
    // __renderBriefingFrameAt(tMs) hijacks setTimeout/setInterval so
    // every choreography event for the segment goes into a sorted
    // queue. Each call fires all events with fireAt ≤ tMs, then
    // renders the globe synchronously and returns the canvas as
    // base64 JPEG. No real-time playback, no MediaRecorder, no
    // audio→visual race. The same proven pattern as the arc-clip
    // renderer's __renderClipFrame.
    client = await page.target().createCDPSession();

    // Defensive: poll up to 30s for the scrub API to come online.
    const fnDeadline = Date.now() + 30_000;
    let fnReady = false;
    while (Date.now() < fnDeadline) {
      fnReady = await page.evaluate(() =>
        typeof window.__beginBriefingScrub === 'function' &&
        typeof window.__renderBriefingFrameAt === 'function' &&
        typeof window.__endBriefingScrub === 'function'
      ).catch(() => false);
      if (fnReady) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (!fnReady) throw new Error('scrub API never became available (stale cache or page error)');

    // Enter scrub mode for this segment. The page replaces its timer
    // primitives + drains startGlobeTimers into the scrub queue.
    const queued = await page.evaluate(
      (idx) => window.__beginBriefingScrub(idx),
      job.segment_idx
    );
    log(`  scrub init: ${queued.queued} event(s) queued for segment ${job.segment_idx}`);

    // Frame loop. Duration comes from job.audio_ms (the narration
    // length, populated by /api/video-jobs/briefings/pending from
    // seg.script.audio_ms). Fall back to a 30s default for legacy
    // segments without timing metadata.
    const durationMs = Number(job.audio_ms) || 30_000;
    const totalFrames = Math.ceil((durationMs / 1000) * BRIEFING_FPS);
    log(`  rendering ${totalFrames} frame(s) at ${BRIEFING_FPS}fps (${(durationMs/1000).toFixed(1)}s)`);

    let written = 0;
    let lastLogPct = 0;
    for (let i = 0; i < totalFrames; i++) {
      if (!_running) break;
      const tMs = (i / BRIEFING_FPS) * 1000;
      // Step 1: page sets up its state for this frame's time. The
      // returned object is small (drained-events count + queue length)
      // so we don't serialize a megabyte of JPEG over CDP.
      await page.evaluate(
        (t) => window.__renderBriefingFrameAt(t),
        tMs
      ).catch(err => {
        throw new Error(`renderBriefingFrameAt(${tMs}ms) failed: ${err.message}`);
      });
      // Step 2: capture the WHOLE viewport (canvas + DOM) so the
      // briefing's title chip, flag chips, captions, and any other
      // briefing-active chrome land in the output alongside the globe.
      // Without this, the canvas-only toDataURL() only captured the
      // WebGL pixels — the DOM scaffolding (which is most of the
      // visual identity of a briefing segment) was invisible.
      const { data } = await client.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 92,
        captureBeyondViewport: false,
      }).catch(err => {
        throw new Error(`captureScreenshot at ${tMs}ms failed: ${err.message}`);
      });
      const fpath = path.join(framesDir, `f${String(i).padStart(7, '0')}.jpg`);
      await fs.promises.writeFile(fpath, Buffer.from(data, 'base64'));
      written++;
      const pct = Math.floor((i / totalFrames) * 100);
      if (pct >= lastLogPct + 25) {
        log(`  frame ${i}/${totalFrames} (${pct}%)`);
        lastLogPct = pct;
      }
    }
    log(`  captured: ${written}/${totalFrames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    try { await page.evaluate(() => window.__endBriefingScrub()); } catch (_) {}

    if (written < 5) throw new Error(`only ${written} frame(s) captured`);

    // Stitch the frames into MP4 at exactly BRIEFING_FPS. No timestamp
    // demuxer needed — every frame is exactly 1/60s of timeline by
    // construction.
    await new Promise((resolve, reject) => {
      const enc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-y',
        '-framerate', String(BRIEFING_FPS),
        '-i', path.join(framesDir, 'f%07d.jpg'),
        '-vf', `scale=${BRIEFING_CAPTURE_W}:${BRIEFING_CAPTURE_H}:force_original_aspect_ratio=increase,crop=${BRIEFING_CAPTURE_W}:${BRIEFING_CAPTURE_H}`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-r', String(BRIEFING_FPS),
        '-fps_mode', 'cfr',
        '-movflags', '+faststart',
        tmpVid,
      ]);
      let stderr = '';
      enc.stderr.on('data', d => { stderr += d.toString(); });
      enc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg(stitch) exit ${code}: ${stderr.slice(0, 500)}`)));
      enc.on('error', reject);
    });
    const videoStat = await fs.promises.stat(tmpVid).catch(() => null);
    if (!videoStat || videoStat.size < 5000) {
      throw new Error(`tmpVid too small (${videoStat?.size || 0} bytes)`);
    }
    log(`  video: ${videoStat.size} bytes`);

    // ── Audio fetch + final mux ──────────────────────────────────────
    // The briefing-audio endpoint requires either a user session or
    // the worker token (server.js has a bypass branch keyed on the
    // same VIDEO_WORKER_TOKEN). Pass the token as ?token=… so the
    // server's worker-token check matches.
    const audioUrl = `${RENDER_HOST}/api/briefing/audio/${job.episode_id}/${job.segment_idx}?token=${encodeURIComponent(TOKEN)}`;
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      const body = await audioRes.text().catch(() => '');
      throw new Error(`audio fetch HTTP ${audioRes.status}: ${body.slice(0, 200)}`);
    }
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    await fs.promises.writeFile(tmpAudio, audioBuf);
    log(`  audio: ${audioBuf.length} bytes`);

    // Probe the briefing music file — if it's installed alongside the
    // worker we add it as a soft bed under the narration; if missing,
    // fall back to the narration-only mux (so the worker still ships
    // a valid MP4 even on a fresh install before the music has been
    // copied over).
    const haveMusic = await fs.promises.stat(BRIEFING_MUSIC_PATH).catch(() => null);
    if (haveMusic && haveMusic.size > 1000) {
      // Stream-loop the music (-stream_loop -1) so a short bed covers
      // any length of narration, then amix it under the voice at low
      // volume. duration=first locks the output length to the narration
      // so we don't bleed extra music after the voice ends.
      await new Promise((resolve, reject) => {
        const mux = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-y',
          '-i', tmpVid,
          '-i', tmpAudio,
          '-stream_loop', '-1',
          '-i', BRIEFING_MUSIC_PATH,
          '-filter_complex',
            `[2:a]volume=${BRIEFING_MUSIC_VOLUME}[bed];` +
            `[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0,` +
            `alimiter=limit=0.98[aout]`,
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '160k',
          '-shortest',
          '-movflags', '+faststart',
          tmpOut,
        ]);
        let stderr = '';
        mux.stderr.on('data', d => { stderr += d.toString(); });
        mux.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg(mux+music) exit ${code}: ${stderr.slice(0, 500)}`)));
        mux.on('error', reject);
      });
    } else {
      // Music file not installed — log once and proceed narration-only.
      warn(`  briefing music not found at ${BRIEFING_MUSIC_PATH} — muxing narration only`);
      await new Promise((resolve, reject) => {
        const mux = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-y',
          '-i', tmpVid,
          '-i', tmpAudio,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-shortest',
          '-movflags', '+faststart',
          tmpOut,
        ]);
        let stderr = '';
        mux.stderr.on('data', d => { stderr += d.toString(); });
        mux.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg(mux) exit ${code}: ${stderr.slice(0, 500)}`)));
        mux.on('error', reject);
      });
    }

    const finalBuf = await fs.promises.readFile(tmpOut);
    return finalBuf;
  } finally {
    if (client) try { await client.detach(); } catch (_) {}
    await browser.close().catch(() => {});
    for (const f of [tmpVid, tmpAudio, tmpOut, concatTxt]) {
      try { await fs.promises.unlink(f); } catch (_) {}
    }
    // Nuke the per-run frames directory in one shot — these can be
    // hundreds of JPEGs (1-2 GB intermediate) on a 30s+ segment.
    try { await fs.promises.rm(framesDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function pollBriefingJobs() {
  if (!DUMP_DIR) return;                              // local-only output; nothing to do without a dump dir
  let jobs;
  try { jobs = await fetchBriefingPending(); }
  catch (err) { warn(`fetchBriefingPending failed: ${err.message}`); return; }
  if (!jobs.length) return;

  log(`fetched ${jobs.length} briefing render job(s)`);
  for (const job of jobs) {
    if (!_running) break;
    const tag = `episode=${job.episode_id} seg=${job.segment_idx} "${(job.segment_title || '').slice(0, 40)}"`;
    log(`▶ briefing ${tag}`);
    const t0 = Date.now();
    try {
      const mp4 = await renderBriefingSegment(job);
      // Folder = <dumpDir>/briefings/<yyyy-mm-dd>/seg-NN.mp4
      const dateStr = (job.target_date || '').slice(0, 10) || `ep-${job.episode_id}`;
      const dir = path.join(DUMP_DIR, 'briefings', dateStr);
      await fs.promises.mkdir(dir, { recursive: true });
      const pad = String(job.segment_idx).padStart(2, '0');
      const dest = path.join(dir, `seg-${pad}.mp4`);
      await fs.promises.writeFile(dest, mp4);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  ✓ ${dest} (${mp4.length} bytes, ${elapsed}s)`);
      await reportBriefingComplete(job.job_id, mp4.length);
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      warn(`  ✗ briefing ${tag} failed after ${elapsed}s: ${err.message}`);
      await reportBriefingSkip(job.job_id, err.message.slice(0, 200));
    }
  }
}

// ── Main loop ──────────────────────────────────────────────────────────
let _running = true;
async function poll() {
  let jobs = [];
  try {
    jobs = await fetchPending();
  } catch (err) {
    warn(`fetchPending failed: ${err.message}`);
    return;
  }
  if (!jobs.length) return;

  log(`fetched ${jobs.length} pending job${jobs.length === 1 ? '' : 's'}`);
  for (const job of jobs) {
    if (!_running) break;
    const tag = `thread=${job.thread_id} "${(job.title || '').slice(0, 50)}"`;
    log(`▶ rendering ${tag}`);
    const t0 = Date.now();
    try {
      const mp4 = await renderVideo(job);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  rendered ${mp4.length} bytes in ${elapsed}s — uploading`);
      const upRes = await uploadResult(job.thread_id, mp4);
      log(`  uploaded: ${JSON.stringify(upRes)}`);
      // Free local mirror of the freshly rendered arc.mp4 — the buffer
      // is already in memory, so this costs us one disk write.
      await dumpArcLocally(job.thread_id, job.title, mp4);
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      warn(`  ✗ ${tag} failed after ${elapsed}s: ${err.message}`);
      await reportSkip(job.thread_id, err.message.slice(0, 100));
    }
  }
}

async function main() {
  log(`worker starting. renderHost=${RENDER_HOST} appHost=${APP_HOST}`);
  if (DUMP_DIR) log(`carousel dumps → ${DUMP_DIR}`);
  else          log(`carousel dump disabled (set dumpDir in ~/.earth00-worker.json to enable)`);
  process.on('SIGTERM', () => { _running = false; log('SIGTERM — finishing current job + exiting'); });
  process.on('SIGINT',  () => { _running = false; log('SIGINT — finishing current job + exiting'); });

  // Sync the local dump folder on a longer cadence than the render
  // poll. Pulling the dump-targets list + every share/*.mp4 every minute
  // would flood the share endpoints with re-renders on cache-cold
  // instances; one pass per ~10 minutes is plenty since the picker cron
  // only fires twice a day. SYNC_EVERY_N_POLLS=10 ≈ 10 minutes at the
  // default 60s poll.
  const SYNC_EVERY_N_POLLS = Math.max(1, parseInt(process.env.WORKER_SYNC_EVERY_N_POLLS || '10', 10));
  let pollCount = 0;

  while (_running) {
    try { await poll(); } catch (err) { warn(`poll loop error: ${err.message}`); }
    // Briefing-segment renders run after the arc-clip pass so a queued
    // arc render isn't starved by a long briefing capture. Each
    // briefing segment is ~30-90s of real-time recording, vs ~30s for
    // an arc clip — keep them sequential to avoid Chromium juggling
    // two heavy WebGL pages at once.
    if (_running) {
      try { await pollBriefingJobs(); } catch (err) { warn(`briefing poll error: ${err.message}`); }
    }
    pollCount++;
    if (DUMP_DIR && pollCount % SYNC_EVERY_N_POLLS === 0) {
      try { await syncDumpsFromServer(); } catch (err) { warn(`dump sync error: ${err.message}`); }
    }
    if (!_running) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  log('worker exiting.');
}

main().catch(err => {
  console.error('[worker] FATAL:', err);
  process.exit(1);
});
