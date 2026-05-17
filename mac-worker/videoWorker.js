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
// 15s clip (up from 10s) — slows the globe spin so arcs/markers on
// any given hemisphere stay visible for ~5s instead of ~3.3s. Combined
// with the bitrate bump (20Mbps) and 60fps capture, this gives the
// viewer enough time to actually see the origin→destination travel
// instead of arcs sliding past too fast.
const DURATION_MS      = 15_000;
const PAGE_TIMEOUT_MS  = 60_000;
const RENDER_TIMEOUT_MS = 90_000;    // hard ceiling per render attempt

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
  const browser = await puppeteer.launch({
    headless: 'new',
    // No --use-angle=swiftshader or related: on Mac, Puppeteer uses real
    // hardware-accelerated WebGL via Apple's drivers. That's the whole
    // reason we're rendering here instead of on Render.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Force GPU acceleration paths that headless can sometimes downgrade
      // — these don't hurt when already on real hardware accel and help
      // when something in the page triggers a fallback.
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
    ],
  });
  const browserLogs = [];
  try {
    const page = await browser.newPage();
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
      return typeof window.__shareGlobeClip === 'function'
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

    // Drive the same recording pipeline that "Share → Clip" uses in
    // the live app. returnBlob: true intercepts the Blob before the
    // iOS-share / web-share / download paths run.
    //
    // Arc draw-in timing override: Puppeteer headless captures the
    // canvas at ~7-15 fps (well below the captureStream(60) target —
    // Chrome throttles offscreen WebGL framerate even with the
    // disable-backgrounding flags). At the in-app default (1.15-1.5s
    // per arc, 0-0.55s stagger), the entire draw-in completes in
    // under 2s of wallclock = ~10-15 captured frames. After MP4
    // compression those frames blur into "arcs instantly appeared."
    // Passing slower durations + bigger stagger here keeps arcs
    // visibly drawing across the first ~7-9s of the 15s clip. In-app
    // behavior is unchanged (no opts → original timings).
    const result = await Promise.race([
      page.evaluate(async (opts) => {
        try {
          if (typeof window.__replayArcAnimations === 'function') {
            window.__replayArcAnimations({
              drawInDurationBase:  3.5,
              drawInDurationRange: 1.5,    // → 3.5-5.0s per arc
              drawInDelayMax:      4.0,    // → up to 4s stagger across arcs
            });
          }
          const r = await window.__shareGlobeClip({
            returnBlob:   true,
            durationMs:   opts.durationMs,
            shareTitle:   `Earth00 · ${opts.title || 'Story'}`,
            shareText:    `${opts.title || 'Story'} — on Earth00`,
            filenameBase: `earth00-thread-${opts.threadId}-clip`,
            overlay: {
              title:    opts.title || 'Story',
              subtitle: opts.subtitle || 'Storyline',
              flagIsos: opts.flagIsos || [],
            },
          });
          if (!r || !r.blob) return { ok: false, error: 'no blob' };
          const buf = await r.blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const chunk = 0x8000;
          let bin = '';
          for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return { ok: true, base64: btoa(bin), ext: r.ext, mime: r.blob.type };
        } catch (e) { return { ok: false, error: e.message }; }
      }, {
        threadId:   job.thread_id,
        durationMs: DURATION_MS,
        title:      job.title,
        subtitle:   job.subtitle,
        flagIsos:   job.flag_isos,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('render hit RENDER_TIMEOUT_MS')), RENDER_TIMEOUT_MS)),
    ]);

    if (!result?.ok) {
      throw new Error(`shareGlobeClip: ${result?.error || 'unknown'}\nlogs:\n${browserLogs.slice(-10).join('\n')}`);
    }
    return Buffer.from(result.base64, 'base64');
  } finally {
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
