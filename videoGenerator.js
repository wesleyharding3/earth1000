/**
 * videoGenerator.js — server-side arc-flyby video generation.
 *
 * Reuses the in-app clip-recording pipeline (window.__shareGlobeClip in
 * root index.html). The flow:
 *
 *   1. Headless Chromium loads https://earth00.com/?thread=:id — same
 *      desktop site a user would visit.
 *   2. Wait for window.__shareGlobeClip + window.__openThread to exist
 *      (signals the globe is initialized).
 *   3. Open the thread programmatically so the globe shows the thread's
 *      flow arcs.
 *   4. Call __shareGlobeClip({ returnBlob: true, durationMs: 10000, ... })
 *      — this triggers the SAME cinematic 360° rotation + arc animation
 *      a real user gets when they hit "Share → Clip" in the app. The
 *      returnBlob: true opt skips iOS/web share and returns the recorded
 *      Blob directly.
 *   5. Convert blob → base64 across the Puppeteer evaluate boundary,
 *      decode to a Buffer on Node side, write to disk.
 *
 * Output: the exact MP4 the app produces for user share — H.264 / AAC,
 * vertical, with title + flags + brand chrome baked in by the existing
 * overlay painter. Cached at /tmp/arc-cache/{threadId}.mp4 for 24h.
 *
 * No ffmpeg, no frame-by-frame stepping, no custom three.js renderer —
 * the production app's MediaRecorder does everything.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WIDTH     = 1080;
const HEIGHT    = 1920;
const DURATION_MS = 10_000;       // matches __shareEntityClip default
const CACHE_DIR = '/tmp/arc-cache';

let _renderingPromise = null;

async function _ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function _captureClip(threadId, threadMeta, desktopAppBase) {
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
      // Headless Chromium throttles RAF + timers when the page isn't
      // "visible" (which is always the case in headless mode). Without
      // these flags, __spinGlobeFor's RAF loop pauses and MediaRecorder
      // stops with a sub-second clip. These match the recipe used by
      // every production headless-screencap pipeline.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=IsolateOrigins,site-per-process',
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

    // Wait for the production globe to mount + the share-clip hook.
    try {
      await page.waitForFunction(() => {
        return typeof window.__shareGlobeClip === 'function'
            && typeof window.__openThread === 'function'
            && !!window.__renderer
            && !!window.__renderer.domElement;
      }, { timeout: 60000 });
    } catch (err) {
      throw new Error(`Globe/share hooks never initialized.\nbrowser-logs:\n${browserLogs.join('\n').slice(0, 2000)}`);
    }

    // Open the thread so the globe focuses on its primary nations and
    // the flow arcs render. Wait briefly for camera focus animation.
    await page.evaluate(async (id) => {
      try {
        await window.__openThread(id);
      } catch (e) {
        console.warn('[capture] __openThread failed:', e.message);
      }
    }, threadId);
    await new Promise(r => setTimeout(r, 3000));

    // DEBUG: Direct screenshot of the page state before recording starts.
    // If this image shows the globe, the issue is specifically with the
    // MediaRecorder+captureStream path in headless mode. If it's also
    // black, the globe simply isn't rendering on the server.
    if (process.env.ARC_DEBUG_PRESHOT) {
      try {
        await page.screenshot({ path: '/tmp/arc-preshot.png' });
        console.log('[capture] pre-record screenshot → /tmp/arc-preshot.png');
      } catch (_) {}
    }

    // Drive the same recording pipeline that "Share → Clip" uses in the
    // app, but with returnBlob: true so we get the raw MP4 back instead
    // of a share dialog. Pass overlay so title/subtitle/flags get baked
    // into the recorded video by the existing _buildClipOverlayPainter.
    //
    // Before recording, call __replayArcAnimations() so the thread's
    // flow arcs draw-in *during* the recording (origin→destination
    // travel) instead of being already-drawn when the recording starts.
    const result = await page.evaluate(async (opts) => {
      try {
        // Reset draw-in state so arcs animate during the capture window.
        if (typeof window.__replayArcAnimations === 'function') {
          window.__replayArcAnimations();
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
        if (!r || !r.blob) return { ok: false, error: 'shareGlobeClip returned no blob' };

        // Serialize blob → base64 in 32KB chunks (avoid call-stack
        // overflow that String.fromCharCode(...spread) hits past ~100KB).
        const buf = await r.blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        let bin = '';
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { ok: true, base64: btoa(bin), ext: r.ext, mime: r.blob.type, bytes: bytes.length };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, {
      threadId,
      durationMs: DURATION_MS,
      title:      threadMeta.title,
      subtitle:   threadMeta.subtitle,
      flagIsos:   threadMeta.flagIsos,
    });

    if (!result?.ok) {
      throw new Error(`shareGlobeClip failed: ${result?.error || 'unknown'}\nbrowser-logs:\n${browserLogs.join('\n').slice(0, 2000)}`);
    }

    return {
      buffer: Buffer.from(result.base64, 'base64'),
      ext:    result.ext,
      mime:   result.mime,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Generate (or fetch cached) arc-flyby video for a thread.
 *
 * @param {number} threadId
 * @param {object} opts
 * @param {string} opts.desktopAppBase — base URL of the desktop app
 *   (default: process.env.DESKTOP_APP_BASE || 'https://earth00.com')
 * @param {object} opts.threadMeta — { title, subtitle, flagIsos } baked
 *   into the video overlay. Caller (server.js arc.mp4 route) populates
 *   from the DB row.
 * @returns {Promise<string>} absolute path to the MP4
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
    const threadMeta = opts.threadMeta || {};
    const { buffer } = await _captureClip(threadId, threadMeta, desktopAppBase);
    await fs.promises.writeFile(outPath, buffer);
    return outPath;
  })();

  try {
    return await _renderingPromise;
  } finally {
    _renderingPromise = null;
  }
}

module.exports = { composeArcVideo, WIDTH, HEIGHT, DURATION_MS, CACHE_DIR };
