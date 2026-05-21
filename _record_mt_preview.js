// Records the mobile transition panel animation as an mp4 so it can be
// previewed as a real video instead of a stack of screenshots.
//
// Approach: Puppeteer opens the local preview at mobile viewport, seeds
// the welcome overlay localStorage, fires __showMobileTransitionPreview,
// then drives the page's animation timeline via the Web Animations API
// — pausing every animation and stepping currentTime forward by 1000/fps
// each frame. Each frame is captured with captureScreenshot and written
// to disk; ffmpeg stitches the PNGs into an mp4 at the target fps.
//
//   node _record_mt_preview.js              # default: 4s at 60fps
//   FPS=30 DURATION_MS=2000 node _record_mt_preview.js
//
// Output: ./carousel_dumps/mobile-transition-preview.mp4
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const URL_      = process.env.URL || 'http://localhost:3900/';
const FPS       = parseInt(process.env.FPS || '60', 10);
const DURATION  = parseInt(process.env.DURATION_MS || '3500', 10);
const OUT       = path.resolve('carousel_dumps/mobile-transition-preview.mp4');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-frames-'));
  console.log(`Recording ${DURATION}ms @ ${FPS}fps → ${OUT}`);
  console.log(`Frames temp dir: ${tmp}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 375, height: 812, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('__earthIntroSeen', '1');
      localStorage.setItem('__seenWelcome', '1');
    } catch (_) {}
  });
  await page.goto(URL_, { waitUntil: 'load', timeout: 30_000 });
  // Wait for the preview entry point to be defined.
  await page.waitForFunction(() => typeof window.__showMobileTransitionPreview === 'function', { timeout: 15_000 });

  // Fire the preview, then pause every animation immediately so we drive
  // them frame-by-frame deterministically.
  await page.evaluate(() => {
    window.__showMobileTransitionPreview();
    const panel = document.getElementById('bMobileTransition');
    const all = panel.getAnimations({ subtree: true });
    for (const a of all) { a.pause(); a.currentTime = 0; }
  });

  const client = await page.target().createCDPSession();
  const frameCount = Math.ceil((DURATION / 1000) * FPS);
  const stepMs = 1000 / FPS;
  for (let i = 0; i < frameCount; i++) {
    const t = i * stepMs;
    await page.evaluate((targetMs) => {
      const all = document.getElementById('bMobileTransition').getAnimations({ subtree: true });
      for (const a of all) { a.currentTime = targetMs; }
    }, t);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(tmp, `f${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (i % 30 === 0) console.log(`  frame ${i + 1}/${frameCount}`);
  }
  await browser.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const res = spawnSync('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(tmp, 'f%05d.png'),
    // libx264 requires even dimensions. Mobile viewport is 375x812 × 2x
    // DSF = 750x1624 — already even, but if DSF is 1 it'd be 375x812
    // which is odd-wide. Pad up to the next even pixel just in case.
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart',
    OUT,
  ], { stdio: 'inherit' });
  if (res.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }

  // Cleanup PNG frames (keep on failure for debugging).
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  fs.rmdirSync(tmp);
  console.log(`✓ ${OUT}`);
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
