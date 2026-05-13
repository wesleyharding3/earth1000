/**
 * record-intro.js — frame-by-frame capture of an App Preview brand clip.
 *
 * Despite the name (kept for backwards-compat), this script captures
 * either the intro or outro animation depending on the SEGMENT env
 * var: SEGMENT=intro (default) or SEGMENT=outro.
 *
 * Why frame-by-frame: Playwright's built-in recordVideo samples the
 * browser at whatever rate the headless render loop happens to run
 * (commonly 20-25fps in headless Chromium, never pinned to 30fps).
 * ffmpeg then duplicates frames to reach 30fps, producing the
 * choppiness you see in any animation that moves smoothly across
 * multiple frames (the orbiting star, scale-in tweens, fade-ins).
 *
 * Instead we use the ?t=<seconds> query param on intro.html /
 * outro.html — which freezes every CSS animation + the JS star orbit
 * at exactly that timestamp — to take one screenshot per output frame
 * at exact 1/30s intervals. ffmpeg then concatenates the pristine PNGs
 * into a 30fps video without any frame interpolation or duplication.
 *
 * Output: media/intro.mp4 or media/outro.mp4 at 1290×2796, 30fps,
 *         H.264, yuv420p.
 *
 * Usage:
 *   1. Preview server running on port 3900
 *   2. node scripts/record-intro.js                  # records intro
 *   3. SEGMENT=outro node scripts/record-intro.js    # records outro
 */

const { chromium } = require('playwright');
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const SEGMENT = (process.env.SEGMENT || 'intro').toLowerCase();
const SEGMENT_CFG = {
  intro: { page: 'intro.html', duration: 5.5 },
  outro: { page: 'outro.html', duration: 3.5 },
};
const cfg = SEGMENT_CFG[SEGMENT];
if (!cfg) {
  console.error(`Unknown SEGMENT '${SEGMENT}'. Use intro or outro.`);
  process.exit(1);
}

const URL_BASE     = `http://localhost:3900/branding/${cfg.page}`;
const WIDTH        = 1290;
const HEIGHT       = 2796;
const FPS          = 30;
const DURATION_S   = cfg.duration;
const FRAME_COUNT  = Math.round(FPS * DURATION_S);

const OUT_DIR      = path.join(__dirname, '..', 'media');
const FRAMES_DIR   = path.join(OUT_DIR, `.frames-${SEGMENT}`);
const MP4_PATH     = path.join(OUT_DIR, `${SEGMENT}.mp4`);

async function main() {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  // Clear any frames from a prior run
  for (const f of fs.readdirSync(FRAMES_DIR)) {
    if (f.endsWith('.png')) fs.unlinkSync(path.join(FRAMES_DIR, f));
  }

  console.log(`Launching headless chromium…`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  console.log(`Capturing ${FRAME_COUNT} frames at ${FPS}fps…`);
  const t0 = Date.now();
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = i / FPS;
    // Open intro.html scrubbed to exact timestamp t. Use 'load' rather
    // than 'networkidle' — there is no network activity beyond the
    // single HTML doc, and 'load' fires once layout + scripts settle.
    await page.goto(`${URL_BASE}?t=${t.toFixed(6)}`, { waitUntil: 'load' });

    const out = path.join(FRAMES_DIR, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({
      path: out,
      type: 'png',
      omitBackground: false,
      // clip ensures we never capture beyond the viewport even if a
      // future edit makes the page taller than the recording target.
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });

    if (i % 15 === 0 || i === FRAME_COUNT - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`\r  frame ${i + 1}/${FRAME_COUNT}  (${elapsed}s elapsed)   `);
    }
  }
  process.stdout.write('\n');

  await context.close();
  await browser.close();

  // Compose frames into a 30fps mp4. Settings rationale:
  //   -framerate 30        treat input PNGs as a 30fps stream (input-side rate)
  //   -c:v libx264         H.264 codec, App Store-required
  //   -pix_fmt yuv420p     widest playback compatibility (Apple recommends)
  //   -profile:v high      maximum quality within iPhone decoders
  //   -level 4.2           caps decoder complexity for older iPhones
  //   -crf 18              visually lossless at our resolution
  //   -movflags +faststart moov atom up front for streamable playback
  console.log(`\nComposing ${MP4_PATH}…`);
  const ff = spawnSync('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.2',
    '-crf', '18',
    '-movflags', '+faststart',
    MP4_PATH,
  ], { stdio: 'inherit' });

  if (ff.status !== 0) {
    console.error('ERROR: ffmpeg failed.');
    process.exit(1);
  }

  // Clean up frame dir (keeps repo tidy; comment out if you want to
  // inspect individual frames during iteration).
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });

  const stats = fs.statSync(MP4_PATH);
  console.log(`\nDone: ${MP4_PATH} (${(stats.size / 1024 / 1024).toFixed(2)} MiB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
