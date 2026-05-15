#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const { resolveHeatmap } = require('./heatmapResolver');
const pool = require('./db');

(async () => {
  try {
    // Purge the bad cached entry first so we hit the new resolver path.
    await pool.query(`DELETE FROM heatmap_qa_cache WHERE question_text ILIKE '%elevation range%'`);
    console.log('Purged cached bad entry.\n');

    const q = process.argv[2] || 'Countries by elevation range (highest minus lowest point)';
    const mode = process.argv[3] || 'rank';
    console.log(`Q: ${q}`);
    console.log(`mode: ${mode}\n`);

    const t0 = Date.now();
    const result = await resolveHeatmap(q, mode);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`\n══════════ RESULT (${dt}s) ══════════`);
    console.log(`legend:           ${result.legend}`);
    console.log(`unit:             ${result.unit}`);
    console.log(`source_note:      ${result.source_note}`);
    console.log(`confidence_tier:  ${result.confidence_tier}`);
    console.log(`is_estimate:      ${result.is_estimate}`);
    console.log(`refusal:          ${result.refusal || '—'}`);
    console.log(`cache:            ${result.cache}`);
    console.log(`row count:        ${result.values?.length || 0}`);

    if (result.values && result.values.length) {
      const sorted = [...result.values].sort((a, b) => a.value - b.value);
      console.log(`\nTop 10 (lowest rank):`);
      sorted.slice(0, 10).forEach(v => console.log(`  ${v.iso}: ${v.value}`));
      console.log(`\nBottom 5 (highest rank):`);
      sorted.slice(-5).forEach(v => console.log(`  ${v.iso}: ${v.value}`));
      const fr = result.values.find(v => v.iso === 'FR');
      const jo = result.values.find(v => v.iso === 'JO');
      console.log(`\nFR (France): ${fr ? fr.value : '— missing'}`);
      console.log(`JO (Jordan): ${jo ? jo.value : '— missing'}`);
      if (fr && jo && mode === 'rank') {
        console.log(`\nSanity check: France ranked ${fr.value < jo.value ? 'BETTER' : 'WORSE'} than Jordan.`);
        console.log(`(Expected: BETTER — France's ~4800m range > Jordan's ~2300m range)`);
      }
    }
  } catch (e) {
    console.error('Test failed:', e.message);
    console.error(e);
  } finally {
    await pool.end();
  }
})();
