/**
 * videoGenerator.js — server-side arc-flyby video generation.
 *
 * Pipeline:
 *   1. Headless Chromium loads https://earth00.com/?thread=:id — the
 *      live desktop site. Reuses the production three.js globe +
 *      flow-arc renderer (no parallel implementation).
 *   2. Wait for window.__shareGlobeClip + window.__openThread (signals
 *      the production globe is mounted).
 *   3. Open the thread programmatically. The app's existing camera-
 *      focus + arc draw-in fires.
 *   4. Wait briefly, then call window.__replayArcAnimations() so the
 *      arcs draw in *during* the recorded window (origin → destination
 *      travel, not pre-drawn static lines).
 *   5. Kick off window.__spinGlobeFor(durationMs) as a fire-and-forget
 *      Promise — same cinematic cubic-ease 360° rotation a user gets
 *      from "Share → Clip" in the live app.
 *   6. While the spin runs, Puppeteer screenshots the globe canvas
 *      every ~33–50ms and writes PNG frames to disk.
 *   7. ffmpeg encodes the frames as 1080×1920 H.264 MP4.
 *
 * Why screenshots instead of MediaRecorder + captureStream: MediaRecorder
 * in headless Chromium with SwiftShader produces sub-second clips
 * (RAF throttling + captureStream quirks). Puppeteer's Page.screenshot
 * works reliably and gives us deterministic frame counts.
 *
 * Output cached at /tmp/arc-cache/{threadId}.mp4 for 24h.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const WIDTH       = 1080;
const HEIGHT      = 1920;
const DURATION_MS = 10_000;
const FPS         = 20;                      // screenshots-per-second target
const FRAME_INTERVAL_MS = Math.floor(1000 / FPS);
const TOTAL_FRAMES = Math.floor(DURATION_MS / FRAME_INTERVAL_MS);
const CACHE_DIR   = '/tmp/arc-cache';
const FRAME_DIR_BASE = '/tmp/arc-frames';

let _renderingPromise = null;

async function _ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function _spawnFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function _captureFrames(threadId, frameDir, desktopAppBase) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    headless: 'new',
  });
  const browserLogs = [];
  try {
    const page = await browser.newPage();
    page.on('console',       msg => browserLogs.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`));
    page.on('pageerror',     err => browserLogs.push(`[pageerror] ${err.message}`));
    page.on('requestfailed', req => browserLogs.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`));

    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

    const url = `${desktopAppBase}/?thread=${threadId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the production globe + thread-open hook.
    try {
      await page.waitForFunction(() => {
        return typeof window.__openThread === 'function'
            && typeof window.__spinGlobeFor === 'function'
            && !!window.__renderer
            && !!window.__renderer.domElement;
      }, { timeout: 60000 });
    } catch (err) {
      throw new Error(`Globe hooks never initialized.\nbrowser-logs:\n${browserLogs.join('\n').slice(0, 2000)}`);
    }

    // Hide UI chrome (header, panels, modals) so screenshots capture only
    // the globe canvas behind. We don't hide canvas-adjacent elements
    // since the canvas itself is z:0 — anything else stacks above.
    await page.addStyleTag({
      content: `
        /* Hide everything that isn't the globe canvas */
        body > *:not(canvas):not(#globeCanvas):not([data-keep-on-capture]) {
          display: none !important;
        }
        canvas { position: fixed !important; inset: 0 !important;
                  width: 100vw !important; height: 100vh !important;
                  z-index: 1 !important; }
        html, body { background: #040810 !important; overflow: hidden !important; }
      `,
    });

    // Open thread → camera focuses, arcs mount + initial draw-in plays.
    await page.evaluate(async (id) => {
      try { await window.__openThread(id); }
      catch (e) { console.warn('[capture] __openThread failed:', e.message); }
    }, threadId);
    await new Promise(r => setTimeout(r, 3000));

    // Reset arc draw-in state so it animates again during the recorded
    // window. Then kick off the cinematic spin as a fire-and-forget
    // Promise — we don't await it because we want to take screenshots
    // *while* it runs.
    await page.evaluate((durationMs) => {
      if (typeof window.__replayArcAnimations === 'function') {
        window.__replayArcAnimations();
      }
      // Start spin in background — capture loop will run alongside it.
      if (typeof window.__spinGlobeFor === 'function') {
        window.__spinGlobeFor(durationMs).catch(() => {});
      }
    }, DURATION_MS);

    // Resolve the canvas element handle once — reuse across the screenshot
    // loop instead of re-querying every frame.
    const canvasHandle = await page.evaluateHandle(() => window.__renderer?.domElement);
    const canvasEl = canvasHandle.asElement();
    if (!canvasEl) throw new Error('renderer.domElement not found');

    // Capture loop. Aim for TOTAL_FRAMES screenshots evenly spread across
    // DURATION_MS. Puppeteer's Page.screenshot adds ~30-80ms latency per
    // call in headless mode, so we don't hit a perfect 20fps — we get
    // whatever the wall clock allows and let ffmpeg slot them at FPS.
    const t0 = Date.now();
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const targetTime = t0 + i * FRAME_INTERVAL_MS;
      const now = Date.now();
      if (now < targetTime) {
        await new Promise(r => setTimeout(r, targetTime - now));
      }
      try {
        await canvasEl.screenshot({
          path: path.join(frameDir, `${String(i).padStart(4, '0')}.png`),
          omitBackground: false,
        });
      } catch (err) {
        // Single-frame failures are non-fatal — the gap will be filled by
        // ffmpeg duplicating the prior frame at encode time.
        console.warn(`[arc-capture] frame ${i} screenshot failed: ${err.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function _encodeVideo(frameDir, outPath) {
  await _spawnFfmpeg([
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(frameDir, '%04d.png'),
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.0',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ]);
}

/**
 * Generate (or fetch cached) arc-flyby video for a thread.
 */
async function composeArcVideo(threadId, opts = {}) {
  await _ensureDir(CACHE_DIR);
  const outPath = path.join(CACHE_DIR, `${threadId}.mp4`);
  try {
    const stat = await fs.promises.stat(outPath);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000 && stat.size > 0) {
      return outPath;
    }
  } catch (_) { /* not cached */ }

  if (_renderingPromise) await _renderingPromise.catch(() => {});

  _renderingPromise = (async () => {
    const desktopAppBase = opts.desktopAppBase || process.env.DESKTOP_APP_BASE || 'https://earth00.com';
    const frameDir = path.join(FRAME_DIR_BASE, String(threadId));
    await _ensureDir(frameDir);
    try {
      await _captureFrames(threadId, frameDir, desktopAppBase);
      await _encodeVideo(frameDir, outPath);
    } finally {
      try {
        const files = await fs.promises.readdir(frameDir);
        for (const f of files) await fs.promises.unlink(path.join(frameDir, f)).catch(() => {});
        await fs.promises.rmdir(frameDir).catch(() => {});
      } catch (_) {}
    }
    return outPath;
  })();

  try {
    return await _renderingPromise;
  } finally {
    _renderingPromise = null;
  }
}

module.exports = { composeArcVideo, WIDTH, HEIGHT, DURATION_MS, FPS, CACHE_DIR };
