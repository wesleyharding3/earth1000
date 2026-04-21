/**
 * Dry-run for the entity tier classifier against live DB.
 *
 * Scope:
 *   • Threads: every active/cooling/dormant thread with a populated
 *     primary_nations and article_count >= 1.
 *   • Lines:   every timeline (any status).
 *
 * What it does:
 *   1. Pulls rows from story_threads and story_timelines.
 *   2. Runs classifyActorTiers() against each row's current primary_nations
 *      as the candidate pool.
 *   3. Prints a before/after diff — old primary list vs new primary and
 *      new secondary. No writes.
 *
 * CLI:
 *   node tmp/dryRunTierClassifier.js              # both, all
 *   node tmp/dryRunTierClassifier.js --threads    # threads only
 *   node tmp/dryRunTierClassifier.js --lines      # lines only
 *   node tmp/dryRunTierClassifier.js --limit=30   # cap per type
 *   node tmp/dryRunTierClassifier.js --throttle=250  # ms between Claude calls
 */
'use strict';

// override: true — the user's shell sometimes has ANTHROPIC_API_KEY=""
// set (empty string), which dotenv by default won't overwrite. Without
// override the classifier's Anthropic client silently falls back.
require('dotenv').config({ override: true });
const pool = require('../db');
const { classifyActorTiers, MAX_PRIMARY, MAX_SECONDARY } = require('../entityTierClassifier');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set after dotenv load. Aborting.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const ONLY_THREADS = argv.includes('--threads');
const ONLY_LINES   = argv.includes('--lines');
const LIMIT        = parseInt(argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10) || null;
const THROTTLE_MS  = parseInt(argv.find(a => a.startsWith('--throttle='))?.split('=')[1] || '250', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtIsoList(arr, color = null) {
  if (!Array.isArray(arr) || !arr.length) return '(none)';
  const joined = arr.join(', ');
  if (!color) return joined;
  const codes = { green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  return `${codes[color] || ''}${joined}${codes.reset}`;
}

function diffSummary(before, primary, secondary) {
  const b = new Set(before);
  const p = new Set(primary);
  const s = new Set(secondary);
  const demoted = before.filter(x => !p.has(x) && s.has(x));     // was primary → now secondary
  const dropped = before.filter(x => !p.has(x) && !s.has(x));    // dropped entirely
  const newPri  = primary.filter(x => !b.has(x));                // added to primary (shouldn't happen w/ current impl)
  const newSec  = secondary.filter(x => !b.has(x));              // added to secondary (shouldn't happen)
  return { demoted, dropped, newPri, newSec };
}

async function runOnThreads() {
  const lim = LIMIT ? `LIMIT ${LIMIT}` : '';
  const { rows } = await pool.query(`
    SELECT id, title, description, primary_category, keywords, primary_nations, article_count, status
    FROM story_threads
    WHERE COALESCE(array_length(primary_nations, 1), 0) > 0
      AND article_count >= 1
    ORDER BY article_count DESC, importance DESC NULLS LAST
    ${lim}
  `);
  console.log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ THREADS — ${rows.length} candidates${LIMIT ? ` (capped at ${LIMIT})` : ''}`.padEnd(75) + '║');
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`);

  let totalClaudeCalls = 0, totalTokensIn = 0, totalTokensOut = 0;
  let statCount = 0, statUnchanged = 0, statNarrowed = 0, statFallback = 0;

  for (const r of rows) {
    const result = await classifyActorTiers({
      title: r.title,
      description: r.description,
      keywords: r.keywords,
      primary_category: r.primary_category,
      candidateIsos: r.primary_nations,
    });
    totalClaudeCalls += result._claudeCalls || 0;
    totalTokensIn    += result._usage?.input_tokens || 0;
    totalTokensIn    += result._usage?.cache_read_input_tokens || 0;
    totalTokensOut   += result._usage?.output_tokens || 0;

    statCount++;
    if (result._fallback) statFallback++;

    const before = Array.isArray(r.primary_nations) ? r.primary_nations.map(s => String(s).toUpperCase()) : [];
    const p = result.primary;
    const s = result.secondary;
    const { demoted, dropped } = diffSummary(before, p, s);

    const unchanged = before.length === p.length && before.every((x, i) => x === p[i]);
    if (unchanged) statUnchanged++;
    else statNarrowed++;

    const tag = result._fallback ? '⚠FB' : (unchanged ? '   ' : ' ✎ ');
    console.log(
      `${tag} thread ${String(r.id).padEnd(5)} [${(r.status || '').padEnd(7)}] art=${String(r.article_count).padStart(3)}  ` +
      `"${String(r.title || '').slice(0, 55)}"`
    );
    console.log(`    before:     ${fmtIsoList(before, 'gray')}`);
    console.log(`    primary:    ${fmtIsoList(p, 'green')}${p.length > MAX_PRIMARY ? ` [OVER CAP]` : ''}`);
    console.log(`    secondary:  ${fmtIsoList(s, 'cyan')}${s.length > MAX_SECONDARY ? ` [OVER CAP]` : ''}`);
    if (demoted.length) console.log(`    demoted:    ${fmtIsoList(demoted, 'gray')}  (was primary → now secondary)`);
    if (dropped.length) console.log(`    dropped:    ${fmtIsoList(dropped, 'gray')}  (no longer either tier)`);
    console.log('');

    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
  }

  console.log(`─── THREAD SUMMARY ───────────────────────────────────────`);
  console.log(`  scanned:         ${statCount}`);
  console.log(`  unchanged:       ${statUnchanged}`);
  console.log(`  narrowed:        ${statNarrowed}`);
  console.log(`  fallback used:   ${statFallback}`);
  console.log(`  claude calls:    ${totalClaudeCalls}`);
  console.log(`  tokens in/out:   ${totalTokensIn} / ${totalTokensOut}`);
}

async function runOnLines() {
  const lim = LIMIT ? `LIMIT ${LIMIT}` : '';
  const { rows } = await pool.query(`
    SELECT id, title, description, primary_category, keywords, primary_nations, article_count, status
    FROM story_timelines
    WHERE COALESCE(array_length(primary_nations, 1), 0) > 0
    ORDER BY article_count DESC NULLS LAST, importance DESC NULLS LAST
    ${lim}
  `);
  console.log(`\n╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ LINES — ${rows.length} candidates${LIMIT ? ` (capped at ${LIMIT})` : ''}`.padEnd(75) + '║');
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`);

  let totalClaudeCalls = 0, totalTokensIn = 0, totalTokensOut = 0;
  let statCount = 0, statUnchanged = 0, statNarrowed = 0, statFallback = 0;

  for (const r of rows) {
    const result = await classifyActorTiers({
      title: r.title,
      description: r.description,
      keywords: r.keywords,
      primary_category: r.primary_category,
      candidateIsos: r.primary_nations,
    });
    totalClaudeCalls += result._claudeCalls || 0;
    totalTokensIn    += result._usage?.input_tokens || 0;
    totalTokensIn    += result._usage?.cache_read_input_tokens || 0;
    totalTokensOut   += result._usage?.output_tokens || 0;

    statCount++;
    if (result._fallback) statFallback++;

    const before = Array.isArray(r.primary_nations) ? r.primary_nations.map(s => String(s).toUpperCase()) : [];
    const p = result.primary;
    const s = result.secondary;
    const { demoted, dropped } = diffSummary(before, p, s);

    const unchanged = before.length === p.length && before.every((x, i) => x === p[i]);
    if (unchanged) statUnchanged++;
    else statNarrowed++;

    const tag = result._fallback ? '⚠FB' : (unchanged ? '   ' : ' ✎ ');
    console.log(
      `${tag} line ${String(r.id).padEnd(5)} [${(r.status || '').padEnd(7)}] art=${String(r.article_count || 0).padStart(4)}  ` +
      `"${String(r.title || '').slice(0, 55)}"`
    );
    console.log(`    before:     ${fmtIsoList(before, 'gray')}`);
    console.log(`    primary:    ${fmtIsoList(p, 'green')}`);
    console.log(`    secondary:  ${fmtIsoList(s, 'cyan')}`);
    if (demoted.length) console.log(`    demoted:    ${fmtIsoList(demoted, 'gray')}  (was primary → now secondary)`);
    if (dropped.length) console.log(`    dropped:    ${fmtIsoList(dropped, 'gray')}  (no longer either tier)`);
    console.log('');

    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
  }

  console.log(`─── LINE SUMMARY ───────────────────────────────────────`);
  console.log(`  scanned:         ${statCount}`);
  console.log(`  unchanged:       ${statUnchanged}`);
  console.log(`  narrowed:        ${statNarrowed}`);
  console.log(`  fallback used:   ${statFallback}`);
  console.log(`  claude calls:    ${totalClaudeCalls}`);
  console.log(`  tokens in/out:   ${totalTokensIn} / ${totalTokensOut}`);
}

(async () => {
  const t0 = Date.now();
  try {
    // Flag semantics: default = both. --lines = lines only. --threads = threads only.
    const runLines   = ONLY_LINES   || !ONLY_THREADS;
    const runThreads = ONLY_THREADS || !ONLY_LINES;
    if (runLines)   await runOnLines();    // lines first — smaller set, faster feedback
    if (runThreads) await runOnThreads();
  } finally {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Dry-run complete in ${secs}s. No writes performed.`);
    await pool.end();
  }
})().catch(err => { console.error(err); process.exit(1); });
