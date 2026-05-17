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
 *     "token":      "<long random string matching VIDEO_WORKER_TOKEN on Render>"
 *   }
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

const POLL_INTERVAL_MS = 60_000;     // poll every minute
// 15s clip — TWO full revolutions in a figure-8 pattern. Yaw goes
// from 0 → 4π linearly while pitch oscillates sin(2π·p) × 0.7 rad
// (~40°), centering the camera over the northern hemisphere during
// the first rotation and the southern during the second. Net effect:
// no country gets stuck at the edge of frame regardless of latitude.
// Math is in index.html → __renderClipFrame.
const DURATION_MS      = 15_000;
const PAGE_TIMEOUT_MS  = 60_000;
const RENDER_TIMEOUT_MS = 360_000;   // hard ceiling per render attempt.
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

    // Brief additional settle so the day/night terminator transitions
    // out of its initial 100%-day-mode state and the flow clock starts
    // advancing. Then __shareGlobeClip's internal replay will reset
    // the draw-in counters and arcs will animate origin→destination
    // during the recording window.
    await new Promise(r => setTimeout(r, 2500));

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
        overlay: {
          title:     opts.title || 'Story',
          subtitle:  opts.subtitle || 'Storyline',
          flagIsos:  opts.flagIsos  || [],
          flagNames: opts.flagNames || [],
        },
      });
    }, {
      spinSeconds,
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
    const ffmpeg = spawn(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(TARGET_FPS), '-i', 'pipe:0',
      // Silent audio track — some downstream consumers (IG) prefer it.
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
      '-r', String(TARGET_FPS), '-t', String(spinSeconds),
      '-c:a', 'aac', '-b:a', '128k',
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
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      warn(`  ✗ ${tag} failed after ${elapsed}s: ${err.message}`);
      await reportSkip(job.thread_id, err.message.slice(0, 100));
    }
  }
}

async function main() {
  log(`worker starting. renderHost=${RENDER_HOST} appHost=${APP_HOST}`);
  process.on('SIGTERM', () => { _running = false; log('SIGTERM — finishing current job + exiting'); });
  process.on('SIGINT',  () => { _running = false; log('SIGINT — finishing current job + exiting'); });

  while (_running) {
    try { await poll(); } catch (err) { warn(`poll loop error: ${err.message}`); }
    if (!_running) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  log('worker exiting.');
}

main().catch(err => {
  console.error('[worker] FATAL:', err);
  process.exit(1);
});
