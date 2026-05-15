#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, question_text, mode, legend, unit, source_note, values, refusal,
              hit_count, last_hit_at, created_at
         FROM heatmap_qa_cache
        WHERE question_text ILIKE '%elevation%'
           OR question_text ILIKE '%highest%'
           OR question_text ILIKE '%terrain%'
        ORDER BY last_hit_at DESC NULLS LAST
        LIMIT 5`
    );
    if (!rows.length) { console.log('No elevation queries found in cache.'); return; }
    for (const r of rows) {
      console.log('\n══════════════════════════════════════════════════════════');
      console.log(`Q: ${r.question_text}`);
      console.log(`mode=${r.mode}  legend=${r.legend}  unit=${r.unit}  hits=${r.hit_count}  last=${r.last_hit_at}`);
      console.log(`source_note: ${r.source_note}`);
      if (r.refusal) console.log(`REFUSAL: ${r.refusal}`);
      const vals = typeof r.values === 'string' ? JSON.parse(r.values) : r.values;
      if (Array.isArray(vals) && vals.length) {
        const sorted = [...vals].sort((a, b) => a.value - b.value);
        console.log(`\ncount: ${vals.length}`);
        console.log(`top 10 (lowest rank/value):`);
        sorted.slice(0, 10).forEach(v => console.log(`  ${v.iso}: ${v.value}`));
        console.log(`bottom 5 (highest rank/value):`);
        sorted.slice(-5).forEach(v => console.log(`  ${v.iso}: ${v.value}`));
        // Specifically check France vs Jordan
        const fr = vals.find(v => v.iso === 'FR');
        const jo = vals.find(v => v.iso === 'JO');
        console.log(`\nFR (France): ${fr ? fr.value : '— not in result'}`);
        console.log(`JO (Jordan): ${jo ? jo.value : '— not in result'}`);
      }
    }
  } catch (e) { console.error(e.message); }
  finally { await pool.end(); }
})();
