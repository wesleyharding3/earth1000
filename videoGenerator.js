/**
 * videoGenerator.js — server-side arc-flyby video generation.
 *
 * Orchestrates:
 *   1. Headless Chromium (Puppeteer) loads /render-globe?thread=:id
 *   2. Page renders deterministic 360-frame three.js globe animation
 *   3. Puppeteer steps frame-by-frame, captures PNG screenshots
 *   4. ffmpeg encodes frames → H.264 MP4 (9:16 vertical, 30fps, 12s)
 *   5. Output cached at /tmp/arc-cache/{threadId}.mp4
 *
 * Output spec:
 *   1080×1920 (Instagram Reels / Threads / Stories native)
 *   12 seconds @ 30fps = 360 frames
 *   H.264 high profile, +faststart, AAC silent audio track (Instagram
 *   Graph API rejects video with no audio stream).
 *
 * Lazy + cached. The /share/thread/:id/arc.mp4 route in server.js
 * calls composeArcVideo() on cache miss.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// @ffmpeg-installer bundles a static ffmpeg binary so we don't depend on
// the host having ffmpeg installed (Render's Node buildpack doesn't).
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const FRAMES    = 360;          // 12s @ 30fps
const FPS       = 30;
const WIDTH     = 1080;
const HEIGHT    = 1920;
const CACHE_DIR = '/tmp/arc-cache';
const FRAME_DIR_BASE = '/tmp/arc-frames';

// One concurrent render at a time — server has limited RAM and ffmpeg
// + Chromium both spike. Queued requests wait their turn.
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

async function _captureFrames(threadId, frameDir, hostBase) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--hide-scrollbars',
    ],
    headless: 'new',
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    const url = `${hostBase}/render-globe?thread=${threadId}&frames=${FRAMES}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    // Page sets window.RENDER_READY = true after texture load + first paint.
    await page.waitForFunction(() => window.RENDER_READY === true, { timeout: 30000 });

    for (let i = 0; i < FRAMES; i++) {
      await page.evaluate(n => window.advanceToFrame(n), i);
      // Wait until the page confirms it rendered the frame we asked for.
      await page.waitForFunction(n => window.LATEST_FRAME === n, { timeout: 5000 }, i);
      await page.screenshot({
        path: path.join(frameDir, `${String(i).padStart(4, '0')}.png`),
        omitBackground: false,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function _encodeVideo(frameDir, outPath) {
  // -shortest with -f lavfi anullsrc gives us a silent AAC track —
  // Instagram Graph API rejects video without an audio stream.
  // -profile:v high -level 4.0 for broad mobile/desktop compatibility.
  // +faststart moves the moov atom to the front so players can begin
  // playback before the file finishes downloading (matters for IG
  // upload responsiveness).
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
 * Generate the arc-flyby video for a thread. Returns the path to the
 * MP4 on disk. Cached: subsequent calls for the same threadId return
 * the cached path without regenerating.
 *
 * @param {number} threadId
 * @param {object} opts
 * @param {string} opts.hostBase — base URL for /render-globe, e.g. http://localhost:3000
 * @returns {Promise<string>} absolute path to the MP4
 */
async function composeArcVideo(threadId, opts = {}) {
  await _ensureDir(CACHE_DIR);
  const outPath = path.join(CACHE_DIR, `${threadId}.mp4`);
  // Cache hit?
  try {
    const stat = await fs.promises.stat(outPath);
    // 24h freshness window
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000 && stat.size > 0) {
      return outPath;
    }
  } catch (_) { /* not cached */ }

  // Serialize renders — only one Chromium at a time.
  if (_renderingPromise) await _renderingPromise.catch(() => {});

  _renderingPromise = (async () => {
    const frameDir = path.join(FRAME_DIR_BASE, String(threadId));
    await _ensureDir(frameDir);
    try {
      const hostBase = opts.hostBase || `http://localhost:${process.env.PORT || 3000}`;
      await _captureFrames(threadId, frameDir, hostBase);
      await _encodeVideo(frameDir, outPath);
    } finally {
      // Clean up frames whether or not encoding succeeded.
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

module.exports = { composeArcVideo, FRAMES, FPS, WIDTH, HEIGHT, CACHE_DIR };
