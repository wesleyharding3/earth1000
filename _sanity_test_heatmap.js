#!/usr/bin/env node
/**
 * _sanity_test_heatmap.js — run a battery of Map-This questions through
 * the new extractor-driven resolver and validate each against expected
 * top/bottom countries + cross-country sanity checks.
 *
 * Designed to be extended: add a new TEST_CASE object below and re-run.
 *
 * Usage:
 *   node _sanity_test_heatmap.js                 # run all cases
 *   node _sanity_test_heatmap.js elevation gdp   # run named cases only
 */

'use strict';

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const { resolveHeatmap } = require('./heatmapResolver');
const pool = require('./db');

const CASES = [
  {
    name: 'elevation',
    question: 'Countries by elevation range (highest minus lowest point)',
    mode: 'rank',
    expected_top_3: ['CN', 'NP', 'PK'],          // Himalaya giants
    expected_bottom_3: ['MV', 'TV'],              // Maldives, Tuvalu
    sanity: [{ iso: 'FR', better_than: 'JO', label: 'France > Jordan (4812m > 2282m)' }],
  },
  {
    name: 'gdp',
    question: 'Countries ranked by total GDP in USD',
    mode: 'rank',
    expected_top_3: ['US', 'CN', 'JP'],          // US #1, China #2, Japan/DE #3-4
    sanity: [
      { iso: 'US', better_than: 'CN', label: 'US > China (current GDP rankings)' },
      { iso: 'DE', better_than: 'BR', label: 'Germany > Brazil' },
    ],
  },
  {
    name: 'population',
    question: 'Countries by total population',
    mode: 'rank',
    expected_top_3: ['IN', 'CN', 'US'],          // India > China since ~2023
    sanity: [
      { iso: 'IN', better_than: 'PK', label: 'India > Pakistan' },
      { iso: 'NG', better_than: 'EG', label: 'Nigeria > Egypt' },
    ],
  },
  {
    name: 'life_expectancy',
    question: 'Countries ranked by life expectancy at birth',
    mode: 'rank',
    expected_top_3: ['JP', 'CH', 'SG'],          // top life expectancies are typically Japan, Switzerland, Singapore, Spain
    sanity: [
      { iso: 'JP', better_than: 'US', label: 'Japan > USA on life expectancy' },
    ],
  },
  {
    name: 'land_area',
    question: 'Countries ranked by total land area',
    mode: 'rank',
    expected_top_3: ['RU', 'CA', 'CN'],
    sanity: [
      { iso: 'RU', better_than: 'US', label: 'Russia > USA on land area' },
      { iso: 'BR', better_than: 'AR', label: 'Brazil > Argentina on land area' },
    ],
  },
];

const requestedNames = process.argv.slice(2);
const toRun = requestedNames.length
  ? CASES.filter(c => requestedNames.includes(c.name))
  : CASES;

(async () => {
  let passCount = 0, failCount = 0;
  for (const c of toRun) {
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`▶ ${c.name}`);
    console.log(`  Q: ${c.question}`);
    console.log(`  mode: ${c.mode}`);

    try {
      // Force fresh so we don't read stale cache from a prior bad answer.
      const t0 = Date.now();
      const r = await resolveHeatmap(c.question, c.mode, { forceFresh: true });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);

      console.log(`  ✓ resolved in ${dt}s  cache=${r.cache}  tier=${r.confidence_tier}`);
      console.log(`  source_note: ${r.source_note}`);
      console.log(`  rows: ${r.values?.length || 0}`);
      if (r.refusal) console.log(`  REFUSAL: ${r.refusal}`);

      const sorted = [...(r.values || [])].sort((a, b) =>
        c.mode === 'rank' ? a.value - b.value : b.value - a.value
      );
      const top10 = sorted.slice(0, 10).map(v => `${v.iso}(${v.value})`).join(' ');
      const bot5  = sorted.slice(-5).map(v => `${v.iso}(${v.value})`).join(' ');
      console.log(`  top 10:    ${top10}`);
      console.log(`  bottom 5:  ${bot5}`);

      // Expected top-3 check (allow any of the named in any order)
      let casePassed = true;
      if (c.expected_top_3?.length) {
        const top3iso = sorted.slice(0, 3).map(v => v.iso);
        const allFound = c.expected_top_3.every(iso => top3iso.includes(iso));
        const partial = c.expected_top_3.filter(iso => top3iso.includes(iso)).length;
        if (allFound) console.log(`  ✓ top-3 match: all of [${c.expected_top_3.join(', ')}]`);
        else { console.log(`  ✗ top-3 partial (${partial}/${c.expected_top_3.length}): got [${top3iso.join(', ')}], expected [${c.expected_top_3.join(', ')}]`); casePassed = false; }
      }
      if (c.expected_bottom_3?.length) {
        const bot3iso = sorted.slice(-3).map(v => v.iso);
        const partial = c.expected_bottom_3.filter(iso => bot3iso.includes(iso)).length;
        if (partial >= 1) console.log(`  ✓ bottom-3 partial (${partial}/${c.expected_bottom_3.length}): contains expected entries`);
        else { console.log(`  ✗ bottom-3 miss: got [${bot3iso.join(', ')}], expected any of [${c.expected_bottom_3.join(', ')}]`); casePassed = false; }
      }

      // Cross-country sanity checks
      for (const s of (c.sanity || [])) {
        const a = r.values.find(v => v.iso === s.iso);
        const b = r.values.find(v => v.iso === s.better_than);
        if (!a || !b) {
          console.log(`  ✗ sanity (${s.label}): missing ${!a ? s.iso : s.better_than}`);
          casePassed = false; continue;
        }
        const aBetter = c.mode === 'rank' ? a.value < b.value : a.value > b.value;
        if (aBetter) console.log(`  ✓ sanity: ${s.label} (${s.iso}=${a.value} vs ${s.better_than}=${b.value})`);
        else { console.log(`  ✗ sanity FAIL: ${s.label} (${s.iso}=${a.value} vs ${s.better_than}=${b.value})`); casePassed = false; }
      }
      if (casePassed) passCount++;
      else failCount++;
    } catch (err) {
      console.log(`  ✗ ERROR: ${err.message}`);
      failCount++;
    }
  }
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`SUMMARY: ${passCount} pass, ${failCount} fail (of ${toRun.length})`);
  await pool.end();
})();
