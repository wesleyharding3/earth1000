#!/usr/bin/env node
'use strict';

/**
 * cleanupNationDesignations.js
 *
 * One-shot rewrite of `primary_nations` / `secondary_nations` on
 * story_threads (and story_timelines) based on article_locations ground
 * truth. Closes the gap created by years of unvalidated dedup unions —
 * threads with 7-22 primary entries, IR sprinkled across unrelated
 * stories, EU appearing on threads no article actually mentions, etc.
 *
 * Default: DRY-RUN. Prints a per-row diff plus aggregate stats and
 * writes a JSON report. Pass --apply to execute the UPDATEs.
 *
 * Caps come from nationDesignations.js: PRIMARY_CAP=4, SECONDARY_CAP=12.
 *
 * Usage:
 *   node cleanupNationDesignations.js                         # dry-run, all threads + timelines
 *   node cleanupNationDesignations.js --threads-only
 *   node cleanupNationDesignations.js --timelines-only
 *   node cleanupNationDesignations.js --limit=200             # cap rows shown
 *   node cleanupNationDesignations.js --out=tmp/cleanup.json  # write report
 *   node cleanupNationDesignations.js --apply                 # actually write
 *   node cleanupNationDesignations.js --apply --only=8742,9911,10022   # cherry-pick
 *
 * Safety:
 *   - Never blanks out a row whose articles have zero article_locations
 *     mentions (extractor offline, ancient articles never tagged) —
 *     leaves the existing arrays alone.
 *   - Skips rows whose new arrays equal the current arrays (no-op).
 *   - Doesn't bump last_updated_at (avoids re-classifying threads as
 *     "active" via the dispatcher's recency check).
 */

process.env.DB_POOL_MAX = '3';
require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const pool = require('./db');
const { computeNationsForItem, PRIMARY_CAP, SECONDARY_CAP } = require('./nationDesignations');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY          = !!ARGV.get('apply');
const THREADS_ONLY   = !!ARGV.get('threads-only');
const TIMELINES_ONLY = !!ARGV.get('timelines-only');
const LIMIT_DISPLAY  = parseInt(ARGV.get('limit') || '60', 10);
const OUT            = ARGV.get('out') || null;
const ONLY = ARGV.get('only')
  ? new Set(String(ARGV.get('only')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean))
  : null;

const TAG = '[cleanup-nations]';

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function diffArrays(oldArr, newArr) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  const removed = oldArr.filter(x => !newSet.has(x));
  const added   = newArr.filter(x => !oldSet.has(x));
  return { removed, added };
}

async function processKind(kind) {
  const isThreads = kind === 'thread';
  const itemTable = isThreads ? 'story_threads'         : 'story_timelines';
  const idCol     = 'id';
  const label     = isThreads ? 'thread' : 'timeline';

  console.log(`\n${TAG} scanning ${kind}s…`);
  const { rows: items } = await pool.query(`
    SELECT ${idCol} AS id, title, primary_nations, secondary_nations,
           article_count, status, importance
      FROM ${itemTable}
     WHERE status IN ('active','cooling','dormant')
       AND article_count >= 2
     ORDER BY importance DESC NULLS LAST, article_count DESC
  `);
  console.log(`${TAG}   loaded ${items.length} ${kind}s`);

  const changes = [];
  const skippedNoMentions = [];
  let processed = 0;
  for (const it of items) {
    processed++;
    if (processed % 200 === 0) {
      process.stdout.write(`${TAG}   processed ${processed}/${items.length}…\r`);
    }
    if (ONLY && !ONLY.has(it.id)) continue;

    const computed = await computeNationsForItem(pool, kind, it.id);
    if (!computed.mentions.length) {
      skippedNoMentions.push({ id: it.id, title: it.title });
      continue;
    }
    const oldPrimary   = (it.primary_nations   || []).map(s => String(s).toUpperCase());
    const oldSecondary = (it.secondary_nations || []).map(s => String(s).toUpperCase());
    const newPrimary   = computed.primary;
    const newSecondary = computed.secondary;

    if (arraysEqual(oldPrimary, newPrimary) && arraysEqual(oldSecondary, newSecondary)) continue;

    changes.push({
      kind: label,
      id: it.id,
      title: it.title,
      status: it.status,
      importance: it.importance,
      articles: it.article_count,
      oldPrimary, newPrimary, primaryDiff: diffArrays(oldPrimary, newPrimary),
      oldSecondary, newSecondary, secondaryDiff: diffArrays(oldSecondary, newSecondary),
      topMentions: computed.mentions.slice(0, 8).map(m => `${m.iso}:${m.count}`).join(' '),
    });
  }

  return { changes, skippedNoMentions, total: items.length };
}

function fmtArr(arr) {
  return arr.length ? `[${arr.join(',')}]` : '[]';
}

function printChange(c, idx, total) {
  const idxLabel = total ? `(${idx + 1}/${total}) ` : '';
  console.log(`\n  ${idxLabel}[${c.kind.toUpperCase()} #${c.id}] imp=${c.importance} arts=${c.articles} status=${c.status}`);
  console.log(`     ${(c.title || '').slice(0, 100)}`);
  console.log(`     primary:   ${fmtArr(c.oldPrimary)}  →  ${fmtArr(c.newPrimary)}`);
  if (c.primaryDiff.removed.length || c.primaryDiff.added.length) {
    const tags = [];
    if (c.primaryDiff.removed.length) tags.push(`-${c.primaryDiff.removed.join(',')}`);
    if (c.primaryDiff.added.length)   tags.push(`+${c.primaryDiff.added.join(',')}`);
    console.log(`                ${tags.join('  ')}`);
  }
  console.log(`     secondary: ${fmtArr(c.oldSecondary)}  →  ${fmtArr(c.newSecondary)}`);
  if (c.secondaryDiff.removed.length || c.secondaryDiff.added.length) {
    const tags = [];
    if (c.secondaryDiff.removed.length) tags.push(`-${c.secondaryDiff.removed.join(',')}`);
    if (c.secondaryDiff.added.length)   tags.push(`+${c.secondaryDiff.added.join(',')}`);
    console.log(`                ${tags.join('  ')}`);
  }
  console.log(`     mentions:  ${c.topMentions}`);
}

async function applyChange(kind, id, primary, secondary) {
  const table = kind === 'thread' ? 'story_threads' : 'story_timelines';
  await pool.query(
    `UPDATE ${table}
        SET primary_nations   = $2::text[],
            secondary_nations = $3::text[]
      WHERE id = $1`,
    [id, primary, secondary]
  );
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} mode=${APPLY ? 'APPLY (writes)' : 'DRY RUN'}`);
  console.log(`${TAG} caps: PRIMARY_CAP=${PRIMARY_CAP} SECONDARY_CAP=${SECONDARY_CAP}`);

  const allChanges = [];
  const stats = { thread: null, timeline: null };

  if (!TIMELINES_ONLY) {
    const r = await processKind('thread');
    stats.thread = r;
    allChanges.push(...r.changes);
  }
  if (!THREADS_ONLY) {
    const r = await processKind('timeline');
    stats.timeline = r;
    allChanges.push(...r.changes);
  }

  // Sort changes by impact: highest importance × biggest primary delta.
  allChanges.sort((a, b) => {
    const aDelta = (a.primaryDiff.removed.length + a.primaryDiff.added.length) * (1 + (a.importance || 0));
    const bDelta = (b.primaryDiff.removed.length + b.primaryDiff.added.length) * (1 + (b.importance || 0));
    return bDelta - aDelta;
  });

  // Aggregate stats
  let primaryEntriesRemoved = 0;
  let primaryEntriesAdded   = 0;
  let secondaryEntriesAdded = 0;
  for (const c of allChanges) {
    primaryEntriesRemoved += c.primaryDiff.removed.length;
    primaryEntriesAdded   += c.primaryDiff.added.length;
    secondaryEntriesAdded += c.secondaryDiff.added.length;
  }

  console.log(`\n${TAG} ── summary ────────────────────────────────────────────`);
  if (stats.thread) {
    console.log(`${TAG}   threads:   ${stats.thread.changes.length} need updates of ${stats.thread.total} (skipped no-mentions: ${stats.thread.skippedNoMentions.length})`);
  }
  if (stats.timeline) {
    console.log(`${TAG}   timelines: ${stats.timeline.changes.length} need updates of ${stats.timeline.total} (skipped no-mentions: ${stats.timeline.skippedNoMentions.length})`);
  }
  console.log(`${TAG}   primary:   -${primaryEntriesRemoved} entries removed, +${primaryEntriesAdded} promoted`);
  console.log(`${TAG}   secondary: +${secondaryEntriesAdded} new entries added`);

  console.log(`\n${TAG} top ${Math.min(LIMIT_DISPLAY, allChanges.length)} changes by impact:`);
  for (let i = 0; i < Math.min(LIMIT_DISPLAY, allChanges.length); i++) {
    printChange(allChanges[i], i, Math.min(LIMIT_DISPLAY, allChanges.length));
  }

  if (OUT) {
    const dir = path.dirname(path.resolve(OUT));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    fs.writeFileSync(OUT, JSON.stringify({
      mode: APPLY ? 'APPLY' : 'DRY_RUN',
      generatedAt: new Date().toISOString(),
      caps: { PRIMARY_CAP, SECONDARY_CAP },
      summary: {
        threadsChanged:   stats.thread?.changes.length || 0,
        timelinesChanged: stats.timeline?.changes.length || 0,
        primaryEntriesRemoved, primaryEntriesAdded, secondaryEntriesAdded,
      },
      changes: allChanges,
    }, null, 2));
    console.log(`\n${TAG} full report → ${OUT}`);
  }

  if (APPLY && allChanges.length) {
    console.log(`\n${TAG} applying ${allChanges.length} updates…`);
    let applied = 0, failed = 0;
    for (const c of allChanges) {
      try {
        await applyChange(c.kind, c.id, c.newPrimary, c.newSecondary);
        applied++;
      } catch (err) {
        console.warn(`${TAG}   ⚠ ${c.kind}#${c.id} failed: ${err.message}`);
        failed++;
      }
    }
    console.log(`${TAG} applied=${applied} failed=${failed}`);
  } else if (APPLY) {
    console.log(`${TAG} no changes to apply.`);
  }

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s${APPLY ? '' : ' (DRY RUN — no writes)'}`);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
