#!/usr/bin/env node
/**
 * build-starfield-bg.js — generates a 1080×1920 starfield PNG that
 * matches the brand's existing starfield (intro.html, outro.html,
 * banner-reddit.html — same RNG seed = 1337, same hue palette, same
 * warm/cool 30/70 ratio).
 *
 * Used as the background for build-preview-instagram.sh so the
 * preview's letterboxed sidebars feel branded instead of black.
 *
 * Why SVG → sharp rasterize: Playwright isn't a project dep, and
 * @napi-rs/canvas isn't installed either. sharp (already in package.json
 * for OG image generation) is the lightest path that doesn't add new
 * deps. SVG keeps the star halos crisp at any output resolution.
 *
 * Output: media/starfield-instagram-bg.png (1080×1920)
 */

'use strict';

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const W = 1080;
const H = 1920;
const N_STARS = 200;   // ~scaled up from banner's 120 (banner is 1920×384)
const SEED    = 1337;  // matches intro/outro/banner

let _seed = SEED;
const rand = () => {
  _seed = (_seed * 9301 + 49297) % 233280;
  return _seed / 233280;
};

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);

// Defs: one shared radial bg gradient, plus per-star halo gradients.
parts.push('<defs>');
parts.push(`<radialGradient id="bg" cx="50%" cy="50%" r="80%">`);
parts.push(`<stop offset="0%" stop-color="#0a0d14"/>`);
parts.push(`<stop offset="75%" stop-color="#000000"/>`);
parts.push('</radialGradient>');

// Pre-compute star data + halo defs.
const stars = [];
for (let i = 0; i < N_STARS; i++) {
  const x   = rand() * W;
  const y   = rand() * H;
  const size = rand() * 1.6 + 0.4;     // bumped slightly for visibility at 1920 tall
  const warm = rand() < 0.30;          // 30% warm orange-tinted, 70% cool blue-tinted
  const hue  = warm ? (32 + rand() * 20) : (200 + rand() * 60);
  const sat  = warm ? (60 + rand() * 40) : (10 + rand() * 20);
  const op   = rand() * 0.5 + 0.30;
  const r    = size * 3.5;
  stars.push({ x, y, size, hue, sat, op, r });
  parts.push(`<radialGradient id="g${i}" cx="50%" cy="50%" r="50%">`);
  parts.push(`<stop offset="0%" stop-color="hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,90%)" stop-opacity="${op.toFixed(3)}"/>`);
  parts.push(`<stop offset="40%" stop-color="hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,70%)" stop-opacity="${(op * 0.4).toFixed(3)}"/>`);
  parts.push(`<stop offset="100%" stop-color="hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,50%)" stop-opacity="0"/>`);
  parts.push('</radialGradient>');
}
parts.push('</defs>');

// Background rect (deep-space gradient).
parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

// Stars: halo + core in a single group per star.
stars.forEach((s, i) => {
  parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${s.r.toFixed(2)}" fill="url(#g${i})"/>`);
  parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${(s.size * 0.55).toFixed(2)}" fill="hsl(${s.hue.toFixed(0)},${s.sat.toFixed(0)}%,95%)" fill-opacity="${s.op.toFixed(3)}"/>`);
});

parts.push('</svg>');
const svg = parts.join('');

const outPath = path.join(__dirname, '..', 'media', 'starfield-instagram-bg.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(outPath)
  .then(info => {
    console.log(`Generated ${outPath}  ${info.width}×${info.height}  ${(info.size / 1024).toFixed(1)} KB`);
  })
  .catch(err => {
    console.error('Failed to rasterize starfield:', err);
    process.exit(1);
  });
