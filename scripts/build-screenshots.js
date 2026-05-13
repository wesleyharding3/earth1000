/**
 * build-screenshots.js — render 9 styled App Store screenshots from
 * raw source frames + iPhone PNGs, using the screenshot-card.html
 * template via headless Playwright.
 *
 * Each output is exactly 1290×2796, PNG, RGB (no alpha) — the iPhone
 * 6.9" App Store tier. Apple auto-derives smaller device tiers from
 * these.
 *
 * Why playwright over ImageMagick/ffmpeg drawtext: typography rendering
 * is the whole game here. Browsers get italic-serif kerning, letter
 * spacing, and antialiasing right. ImageMagick's text engine produces
 * passable but obviously-not-modern-app screenshots.
 *
 * Usage:
 *   1. Preview server running on port 3900 (serves /branding/*)
 *   2. Source PNGs at www/branding/screenshots-src/
 *   3. node scripts/build-screenshots.js
 *   Output → media/screenshots/01_heatmap.png … 09_globe.png
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const W = 1290, H = 2796;
const OUT_DIR = path.join(__dirname, '..', 'media', 'screenshots');

// 9 screenshots in App Store display order. `subtitle: null` =
// single-line headline only (used for info-dense screens where the
// visual itself already says enough).
const SHOTS = [
  {
    img:      'screenshots-src/01_heatmap.png',
    headline: "See the world's pulse",
    subtitle: 'Which countries are making the most news right now',
    out:      '01_heatmap.png',
  },
  {
    img:      'screenshots-src/02_arcs.png',
    headline: 'Stories move across borders',
    subtitle: 'How news connects the world, in real time',
    out:      '02_arcs.png',
  },
  {
    img:      'screenshots-src/03_country.png',
    headline: 'Tap any country',
    subtitle: "Today's headlines from every press",
    out:      '03_country.png',
  },
  {
    img:      'screenshots-src/04_briefing.png',
    headline: 'Your daily briefing',
    subtitle: null,            // dense screen
    out:      '04_briefing.png',
  },
  {
    img:      'screenshots-src/05_timeline.png',
    headline: 'Watch events unfold',
    subtitle: null,            // dense screen
    out:      '05_timeline.png',
  },
  {
    img:      'screenshots-src/06_threads.png',
    headline: 'Storylines, not feeds',
    subtitle: null,            // dense screen
    out:      '06_threads.png',
  },
  {
    img:      'screenshots-src/07_city.png',
    headline: 'Local where you want it',
    subtitle: 'From capitals to cities, in their own language',
    out:      '07_city.png',
  },
  {
    img:      'screenshots-src/08_keywords.png',
    headline: "What everyone's talking about",
    subtitle: 'Trending names and places, ranked daily',
    out:      '08_keywords.png',
  },
  {
    img:      'screenshots-src/09_globe.png',
    headline: 'Track world events',
    subtitle: 'A live globe of the news in your pocket',
    out:      '09_globe.png',
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Launching headless chromium…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  for (const s of SHOTS) {
    const params = new URLSearchParams();
    params.set('img', s.img);
    params.set('headline', s.headline);
    if (s.subtitle) params.set('subtitle', s.subtitle);
    const url = `http://localhost:3900/branding/screenshot-card.html?${params.toString()}`;
    process.stdout.write(`  ${s.out} … `);

    await page.goto(url, { waitUntil: 'networkidle' });
    // The shot <img> may load slightly after networkidle on first paint;
    // wait until its naturalWidth is non-zero so the captured frame
    // never catches it mid-load.
    await page.waitForFunction(() => {
      const i = document.getElementById('shot');
      return i && i.complete && i.naturalWidth > 0;
    }, { timeout: 10000 });

    const out = path.join(OUT_DIR, s.out);
    await page.screenshot({
      path: out,
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: W, height: H },
    });

    const stat = fs.statSync(out);
    console.log(`${(stat.size / 1024).toFixed(0)} KB`);
  }

  await context.close();
  await browser.close();
  console.log(`\nDone — ${SHOTS.length} PNGs in ${OUT_DIR}`);
}

main().catch(err => { console.error(err); process.exit(1); });
