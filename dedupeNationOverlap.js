#!/usr/bin/env node
'use strict';

/**
 * dedupeNationOverlap.js
 *
 * Targeted fix for legacy rows where the same ISO appears in both
 * `primary_nations` and `secondary_nations`, OR appears more than once
 * within either array. Strictly a string-level cleanup — does NOT call
 * article_locations or run the full re-validation pipeline. Pairs with
 * cleanupNationDesignations.js: that script rewrote 625 rows via
 * article ground truth; this one cleans up the 529 rows the cleanup
 * skipped (no extractor mentions) plus any future leak that slips
 * past the new write-site guard.
 *
 * Rules (same as enforceDisjointAndCapped in nationDesignations.js):
 *   1. Normalize each ISO (uppercase, UK→GB, drop malformed).
 *   2. Dedupe within each array.
 *   3. secondary minus primary (primary wins).
 *   4. Cap primary at 4, secondary at 12.
 *
 * Default: DRY-RUN. Pass --apply to write.
 *
 * Usage:
 *   node dedupeNationOverlap.js                # dry-run on threads + timelines
 *   node dedupeNationOverlap.js --apply
 *   node dedupeNationOverlap.js --threads-only
 *   node dedupeNationOverlap.js --timelines-only
 *   node dedupeNationOverlap.js --limit=200    # cap rows shown
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const { enforceDisjointAndCapped, PRIMARY_CAP, SECONDARY_CAP } = require('./nationDesignations');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY          = !!ARGV.get('apply');
const THREADS_ONLY   = !!ARGV.get('threads-only');
const TIMELINES_ONLY = !!ARGV.get('timelines-only');
const LIMIT_DISPLAY  = parseInt(ARGV.get('limit') || '60', 10);

const TAG = '[dedupe-overlap]';

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function processKind(kind) {
  const itemTable = kind === 'thread' ? 'story_threads' : 'story_timelines';
  console.log(`\n${TAG} scanning ${kind}s…`);
  const { rows } = await pool.query(`
    SELECT id, title, primary_nations, secondary_nations, status, importance, article_count
      FROM ${itemTable}
     WHERE primary_nations IS NOT NULL OR secondary_nations IS NOT NULL
  `);
  console.log(`${TAG}   loaded ${rows.length} ${kind}s`);

  const changes = [];
  for (const r of rows) {
    const oldP = r.primary_nations   || [];
    const oldS = r.secondary_nations || [];
    const { primary: newP, secondary: newS } = enforceDisjointAndCapped(oldP, oldS);
    if (arraysEqual(oldP, newP) && arraysEqual(oldS, newS)) continue;

    // What changed? Categorize the clean for the report.
    const dupesInPrimary   = oldP.length - new Set(oldP.map(s => String(s).toUpperCase())).size;
    const dupesInSecondary = oldS.length - new Set(oldS.map(s => String(s).toUpperCase())).size;
    const overlapBoth      = (oldP || []).filter(p => (oldS || []).includes(p));
    const overCap          = Math.max(0, oldP.length - PRIMARY_CAP) + Math.max(0, oldS.length - SECONDARY_CAP);
    const malformedDropped = (oldP.length + oldS.length) - (newP.length + newS.length) - overCap - overlapBoth.length - dupesInPrimary - dupesInSecondary;

    changes.push({
      kind, id: r.id, title: r.title, status: r.status, importance: r.importance, articles: r.article_count,
      oldP, oldS, newP, newS,
      issues: {
        dupesInPrimary, dupesInSecondary,
        overlapBoth, overCap, malformedDropped: Math.max(0, malformedDropped),
      },
    });
  }
  return changes;
}

function printChange(c) {
  console.log(`\n  [${c.kind.toUpperCase()} #${c.id}] imp=${c.importance} arts=${c.articles} status=${c.status}`);
  console.log(`     ${(c.title || '').slice(0, 100)}`);
  console.log(`     primary:   [${c.oldP.join(',')}]  →  [${c.newP.join(',')}]`);
  console.log(`     secondary: [${c.oldS.join(',')}]  →  [${c.newS.join(',')}]`);
  const tags = [];
  if (c.issues.dupesInPrimary)   tags.push(`${c.issues.dupesInPrimary} dupes-in-primary`);
  if (c.issues.dupesInSecondary) tags.push(`${c.issues.dupesInSecondary} dupes-in-secondary`);
  if (c.issues.overlapBoth.length) tags.push(`overlap=[${c.issues.overlapBoth.join(',')}]`);
  if (c.issues.overCap)          tags.push(`${c.issues.overCap} over-cap`);
  if (c.issues.malformedDropped) tags.push(`${c.issues.malformedDropped} malformed`);
  if (tags.length) console.log(`     issues: ${tags.join(' · ')}`);
}

async function applyChange(c) {
  const table = c.kind === 'thread' ? 'story_threads' : 'story_timelines';
  await pool.query(
    `UPDATE ${table}
        SET primary_nations   = $2::text[],
            secondary_nations = $3::text[]
      WHERE id = $1`,
    [c.id, c.newP, c.newS]
  );
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} mode=${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`${TAG} caps: PRIMARY_CAP=${PRIMARY_CAP} SECONDARY_CAP=${SECONDARY_CAP}`);

  const all = [];
  if (!TIMELINES_ONLY) all.push(...(await processKind('thread')));
  if (!THREADS_ONLY)   all.push(...(await processKind('timeline')));

  // Sort by impact: rows with overlap (the worst kind) first, then by importance
  all.sort((a, b) => {
    const aSev = a.issues.overlapBoth.length * 10 + a.issues.dupesInPrimary * 5 + a.issues.dupesInSecondary * 2;
    const bSev = b.issues.overlapBoth.length * 10 + b.issues.dupesInPrimary * 5 + b.issues.dupesInSecondary * 2;
    if (bSev !== aSev) return bSev - aSev;
    return (b.importance || 0) - (a.importance || 0);
  });

  // Aggregate counts
  let withOverlap = 0, withDupesInPrimary = 0, withDupesInSecondary = 0, withOverCap = 0;
  for (const c of all) {
    if (c.issues.overlapBoth.length)   withOverlap++;
    if (c.issues.dupesInPrimary)       withDupesInPrimary++;
    if (c.issues.dupesInSecondary)     withDupesInSecondary++;
    if (c.issues.overCap)              withOverCap++;
  }

  console.log(`\n${TAG} ── summary ────────────────────────────────────────`);
  console.log(`${TAG}   rows needing fix: ${all.length}`);
  console.log(`${TAG}   primary↔secondary overlap: ${withOverlap}`);
  console.log(`${TAG}   dupes within primary:      ${withDupesInPrimary}`);
  console.log(`${TAG}   dupes within secondary:    ${withDupesInSecondary}`);
  console.log(`${TAG}   over PRIMARY/SECONDARY caps: ${withOverCap}`);

  console.log(`\n${TAG} top ${Math.min(LIMIT_DISPLAY, all.length)} by severity:`);
  for (let i = 0; i < Math.min(LIMIT_DISPLAY, all.length); i++) printChange(all[i]);

  if (APPLY && all.length) {
    console.log(`\n${TAG} applying ${all.length} updates…`);
    let ok = 0, fail = 0;
    for (const c of all) {
      try { await applyChange(c); ok++; }
      catch (err) { console.warn(`${TAG}   ⚠ ${c.kind}#${c.id}: ${err.message}`); fail++; }
    }
    console.log(`${TAG} applied=${ok} failed=${fail}`);
  }
  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s${APPLY ? '' : ' (DRY RUN)'}`);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
