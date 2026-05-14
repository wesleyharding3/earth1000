/**
 * build-banner.js — render the Reddit banner as JPEG (≤500 KB).
 * Output: media/banner-reddit.jpg at 1920×384.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const W = 1920, H = 384;
const OUT = path.join(__dirname, '..', 'media', 'banner-reddit.jpg');
const URL = 'http://localhost:3900/branding/banner-reddit.html';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'networkidle' });
  // No images on the new design — SVG arcs only. Allow one frame for
  // the starfield canvas + font rendering to settle.
  await page.waitForTimeout(200);

  // JPEG at q=88 — visually lossless at this size, well under 500 KB.
  // Bump quality down if size exceeds target; bump up for crispness.
  await page.screenshot({
    path: OUT,
    type: 'jpeg',
    quality: 88,
    clip: { x: 0, y: 0, width: W, height: H },
  });

  await context.close();
  await browser.close();

  const stat = fs.statSync(OUT);
  console.log(`${OUT}  ${(stat.size / 1024).toFixed(1)} KB`);
}

main().catch(err => { console.error(err); process.exit(1); });
