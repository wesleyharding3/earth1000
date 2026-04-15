/**
 * scripts/auditThreadNations.js
 *
 * Re-derives `primary_nations` for every active/cooling/dormant thread and
 * timeline using the strict extractor in nationExtractor.js (title +
 * description only, with demonyms, aliases, major cities, and ambiguity
 * guards). Prints a diff and only writes when --write is passed.
 *
 * Usage:
 *   node scripts/auditThreadNations.js                  # dry run, prints diff
 *   node scripts/auditThreadNations.js --write          # apply changes
 *   node scripts/auditThreadNations.js --threads        # threads only
 *   node scripts/auditThreadNations.js --timelines      # timelines only
 *   node scripts/auditThreadNations.js --thread=123     # single thread by ID
 *   node scripts/auditThreadNations.js --timeline=42    # single timeline by ID
 *   node scripts/auditThreadNations.js --changed-only   # only print rows that changed
 *
 * Diff legend:
 *   +XX  newly added country
 *   -XX  removed country
 *   =XX  unchanged (only shown when --changed-only is NOT set)
 */

'use strict';

require('dotenv').config({ override: true });
const pool = require('../db');
const { loadGazetteer, extractNations } = require('../nationExtractor');

const args = process.argv.slice(2);
const WRITE         = args.includes('--write');
const THREADS_ONLY  = args.includes('--threads');
const TIMELINES_ONLY = args.includes('--timelines');
const CHANGED_ONLY  = args.includes('--changed-only');
const SINGLE_THREAD = (() => {
  const a = args.find(a => a.startsWith('--thread='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const SINGLE_TIMELINE = (() => {
  const a = args.find(a => a.startsWith('--timeline='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();

function diff(oldArr, newArr) {
  const oldSet = new Set(oldArr || []);
  const newSet = new Set(newArr || []);
  const added   = [...newSet].filter(x => !oldSet.has(x));
  const removed = [...oldSet].filter(x => !newSet.has(x));
  const same    = [...newSet].filter(x => oldSet.has(x));
  return { added, removed, same, changed: added.length > 0 || removed.length > 0 };
}

function fmtDiff(d) {
  const parts = [];
  for (const iso of d.added)   parts.push(`\x1b[32m+${iso}\x1b[0m`);
  for (const iso of d.removed) parts.push(`\x1b[31m-${iso}\x1b[0m`);
  if (!CHANGED_ONLY) for (const iso of d.same) parts.push(`\x1b[2m=${iso}\x1b[0m`);
  return parts.length ? parts.join(' ') : '\x1b[2m(none)\x1b[0m';
}

async function processRows(kind, table, rows, gaz) {
  let written = 0, changed = 0;
  for (const r of rows) {
    const text = (r.title || '') + ' \n ' + (r.description || '');
    const next = extractNations(text, gaz);
    const d = diff(r.primary_nations, next);

    if (d.changed) changed++;

    if (!CHANGED_ONLY || d.changed) {
      const id = String(r.id).padStart(6);
      const title = (r.title || '').slice(0, 70).replace(/\s+/g, ' ');
      console.log(`${kind} #${id}  ${fmtDiff(d)}  ${title}`);
    }

    if (WRITE && d.changed) {
      await pool.query(
        `UPDATE ${table} SET primary_nations = $1 WHERE id = $2`,
        [next, r.id]
      );
      written++;
    }
  }
  return { changed, written, total: rows.length };
}

(async () => {
  console.log(`[audit] Loading gazetteer…`);
  const gaz = await loadGazetteer(pool);
  console.log(`[audit] Gazetteer ready: ${gaz.sortedNames.length} names`);
  console.log(`[audit] Mode: ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

  let threadStats = null, timelineStats = null;

  if (!TIMELINES_ONLY) {
    let q, params;
    if (SINGLE_THREAD) {
      q = `SELECT id, title, description, primary_nations FROM story_threads WHERE id = $1`;
      params = [SINGLE_THREAD];
    } else {
      q = `SELECT id, title, description, primary_nations FROM story_threads
           WHERE status IN ('active','cooling','dormant')
           ORDER BY id`;
      params = [];
    }
    const { rows } = await pool.query(q, params);
    console.log(`── THREADS (${rows.length}) ──`);
    threadStats = await processRows('THR', 'story_threads', rows, gaz);
  }

  if (!THREADS_ONLY) {
    let q, params;
    if (SINGLE_TIMELINE) {
      q = `SELECT id, title, description, primary_nations FROM story_timelines WHERE id = $1`;
      params = [SINGLE_TIMELINE];
    } else {
      q = `SELECT id, title, description, primary_nations FROM story_timelines
           WHERE status IN ('active','cooling','dormant')
           ORDER BY id`;
      params = [];
    }
    const { rows } = await pool.query(q, params);
    console.log(`\n── TIMELINES (${rows.length}) ──`);
    timelineStats = await processRows('TML', 'story_timelines', rows, gaz);
  }

  console.log(`\n── SUMMARY ──`);
  if (threadStats)   console.log(`Threads:    ${threadStats.changed}/${threadStats.total} would change${WRITE ? `  (${threadStats.written} written)` : ''}`);
  if (timelineStats) console.log(`Timelines:  ${timelineStats.changed}/${timelineStats.total} would change${WRITE ? `  (${timelineStats.written} written)` : ''}`);
  if (!WRITE) console.log(`\nDry run only. Re-run with --write to apply.`);

  await pool.end();
})().catch(err => {
  console.error('[audit] failed:', err);
  pool.end().finally(() => process.exit(1));
});
