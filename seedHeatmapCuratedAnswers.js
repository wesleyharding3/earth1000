#!/usr/bin/env node
'use strict';

/**
 * seedHeatmapCuratedAnswers.js
 *
 * Pre-populates `heatmap_qa_cache` with hand-picked common questions so
 * first-time askers hit the cache instead of paying the cold-Claude cost
 * (4–12s + ~$0.20 per question). Each row is marked source='curated' and
 * is_pinned=true — survives any future eviction pass and shows up to the
 * frontend identically to a Claude-derived row.
 *
 * Mechanics:
 *   For each (question, mode) pair below, call resolveHeatmap(). That
 *   function checks the cache first; on miss it runs the full Claude
 *   pipeline and INSERTs as source='claude'. We then UPDATE the row to
 *   flip source→'curated' + is_pinned=true and stamp source_note with
 *   the seeding context. Result: a fresh seeded library that costs ~$5
 *   of Claude credits one-time and saves $0.20/miss forever after.
 *
 * Usage:
 *   node seedHeatmapCuratedAnswers.js                 # dry-run: prints the question list, no Claude calls
 *   node seedHeatmapCuratedAnswers.js --apply         # call Claude for any uncached entries + flip them to curated
 *   node seedHeatmapCuratedAnswers.js --apply --refresh   # also re-Claude entries that already exist (replaces stale values)
 *   node seedHeatmapCuratedAnswers.js --apply --only="GDP per capita,Population"
 *
 * Cost: ~26 questions × ~$0.20 each ≈ $5 if everything is cold.
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const crypto = require('crypto');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY   = !!ARGV.get('apply');
const REFRESH = !!ARGV.get('refresh');
const ONLY    = ARGV.get('only')
  ? new Set(String(ARGV.get('only')).split(',').map(s => s.trim().toLowerCase()))
  : null;

const TAG = '[seed-heatmap]';

// ─────────────────────────────────────────────────────────────────────────────
// THE CURATED LIST
// ─────────────────────────────────────────────────────────────────────────────
// Picked to cover the universal "first-thing-a-user-asks" space. Mode is
// the renderer enum: 'percent' (0–100 heat scale), 'rank' (integers, 1=top),
// 'binary' (0/1, single shade for 1).
//
// Guidelines for adding to this list:
//   - The question should be something a first-time visitor with zero
//     priors would type unprompted.
//   - The answer should be reasonably stable year over year (avoid live
//     metrics like "current inflation" — they go stale fast).
//   - Mode should match how the value is naturally compared. Use rank
//     when raw magnitudes vary 1000x (population, GDP nominal, CO2
//     absolute). Use percent for ratios (literacy, urbanization). Use
//     binary for membership/categorical (NATO member, predominantly X).
//   - Keep wording terse and canonical — the cache hashes lowercased,
//     whitespace-collapsed text. "GDP per capita" not "GDP per Capita?".
const QUESTIONS = [
  // Economy
  { question: 'GDP per capita',                              mode: 'percent', tier: 'economy' },
  { question: 'GDP',                                         mode: 'rank',    tier: 'economy' },
  { question: 'Unemployment rate',                           mode: 'percent', tier: 'economy' },
  { question: 'Inflation rate',                              mode: 'percent', tier: 'economy' },
  { question: 'Public debt as percent of GDP',               mode: 'percent', tier: 'economy' },

  // Demographics
  { question: 'Population',                                  mode: 'rank',    tier: 'demographics' },
  { question: 'Median age',                                  mode: 'rank',    tier: 'demographics' },
  { question: 'Life expectancy',                             mode: 'rank',    tier: 'demographics' },
  { question: 'Urbanization rate',                           mode: 'percent', tier: 'demographics' },

  // Education
  { question: 'Literacy rate',                               mode: 'percent', tier: 'education' },

  // Health
  { question: 'Healthcare spending as percent of GDP',       mode: 'percent', tier: 'health' },
  { question: 'Infant mortality rate',                       mode: 'rank',    tier: 'health' },
  { question: 'Doctors per 1000 people',                     mode: 'rank',    tier: 'health' },

  // Religion / culture
  { question: 'Predominantly Muslim',                        mode: 'binary',  tier: 'religion' },
  { question: 'Predominantly Christian',                     mode: 'binary',  tier: 'religion' },

  // Politics
  { question: 'Democracy index',                             mode: 'percent', tier: 'politics' },
  { question: 'Corruption perceptions index',                mode: 'percent', tier: 'politics' },
  { question: 'Has nuclear weapons',                         mode: 'binary',  tier: 'politics' },

  // Infrastructure
  { question: 'Internet penetration rate',                   mode: 'percent', tier: 'infrastructure' },
  { question: 'Electricity access',                          mode: 'percent', tier: 'infrastructure' },

  // Environment
  { question: 'CO2 emissions per capita',                    mode: 'rank',    tier: 'environment' },
  { question: 'Renewable energy share of total energy',      mode: 'percent', tier: 'environment' },

  // Military / geopolitics
  { question: 'Military spending as percent of GDP',         mode: 'percent', tier: 'military' },
  { question: 'NATO member',                                 mode: 'binary',  tier: 'geopolitics' },
  { question: 'EU member',                                   mode: 'binary',  tier: 'geopolitics' },
  { question: 'BRICS member',                                mode: 'binary',  tier: 'geopolitics' },
];

function hashKey(question, mode) {
  const normalized = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
}

async function existingRow(question, mode) {
  const r = await pool.query(
    `SELECT id, source, is_pinned, jsonb_array_length(values) AS n_values, refusal IS NOT NULL AS refused
       FROM heatmap_qa_cache
      WHERE question_hash = $1 AND mode = $2`,
    [hashKey(question, mode), mode]
  );
  return r.rows[0] || null;
}

async function markCurated(rowId, tier) {
  await pool.query(
    `UPDATE heatmap_qa_cache
        SET source = 'curated',
            is_pinned = TRUE,
            source_note = COALESCE(source_note, '') ||
                          CASE WHEN COALESCE(source_note,'') = '' THEN '' ELSE ' · ' END ||
                          'Curated seed (${tier})'
      WHERE id = $1`,
    [rowId]
  );
}

async function deleteRow(rowId) {
  await pool.query(`DELETE FROM heatmap_qa_cache WHERE id = $1`, [rowId]);
}

async function callResolveHeatmap(question, mode) {
  const { resolveHeatmap } = require('./heatmapResolver');
  return resolveHeatmap(question, mode, {});
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} mode=${APPLY ? 'APPLY' : 'DRY RUN'}${REFRESH ? ' refresh=true' : ''}`);
  console.log(`${TAG} ${QUESTIONS.length} questions in seed list\n`);

  let toSeed = 0, alreadyCurated = 0, alreadyClaude = 0, willCallClaude = 0;
  const plan = [];

  for (const q of QUESTIONS) {
    if (ONLY && !ONLY.has(q.question.toLowerCase())) continue;
    const existing = await existingRow(q.question, q.mode);
    let action;
    if (!existing) {
      action = 'CALL_CLAUDE_AND_CURATE';
      willCallClaude++;
    } else if (existing.source === 'curated' && !REFRESH) {
      action = 'ALREADY_CURATED_SKIP';
      alreadyCurated++;
    } else if (existing.source === 'claude' && !REFRESH) {
      action = 'FLIP_TO_CURATED_NO_CLAUDE';
      alreadyClaude++;
    } else if (REFRESH) {
      action = 'REFRESH_AND_CURATE';
      willCallClaude++;
    }
    plan.push({ ...q, existing, action });
    if (action !== 'ALREADY_CURATED_SKIP') toSeed++;
  }

  console.log(`${TAG} plan: seed=${toSeed} (${willCallClaude} fresh Claude calls, ${alreadyClaude} flip-only)  already_curated=${alreadyCurated}\n`);
  for (const p of plan) {
    const exTag = p.existing ? `existing[${p.existing.source}${p.existing.is_pinned ? ',pinned' : ''}, n=${p.existing.n_values}${p.existing.refused ? ', refused' : ''}]` : 'NEW';
    console.log(`  ${p.action.padEnd(28)} ${p.tier.padEnd(15)} ${p.mode.padEnd(7)} "${p.question}"  ${exTag}`);
  }

  if (!APPLY) {
    console.log(`\n${TAG} dry-run only. Re-run with --apply to seed.`);
    await pool.end();
    return;
  }

  console.log(`\n${TAG} executing…\n`);
  let seeded = 0, flipped = 0, refused = 0, failed = 0;
  for (const p of plan) {
    try {
      if (p.action === 'ALREADY_CURATED_SKIP') continue;
      if (p.action === 'FLIP_TO_CURATED_NO_CLAUDE') {
        await markCurated(p.existing.id, p.tier);
        flipped++;
        console.log(`  ↺ flipped         "${p.question}" (${p.mode}) → curated+pinned`);
        continue;
      }
      // CALL_CLAUDE_AND_CURATE or REFRESH_AND_CURATE
      if (p.action === 'REFRESH_AND_CURATE' && p.existing) {
        await deleteRow(p.existing.id);
      }
      const t = Date.now();
      const result = await callResolveHeatmap(p.question, p.mode);
      const ms = Date.now() - t;
      if (result.refusal) {
        refused++;
        console.log(`  ✕ refused (${ms}ms)   "${p.question}" (${p.mode}) — ${(result.refusal || '').slice(0, 80)}`);
        continue;
      }
      const fresh = await existingRow(p.question, p.mode);
      if (!fresh) throw new Error('row not present after resolveHeatmap');
      await markCurated(fresh.id, p.tier);
      seeded++;
      console.log(`  ✓ seeded (${ms}ms)    "${p.question}" (${p.mode}) — ${result.values?.length || 0} country values`);
    } catch (err) {
      failed++;
      console.warn(`  ⚠ failed             "${p.question}" (${p.mode}): ${err.message}`);
    }
  }

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — seeded=${seeded} flipped=${flipped} refused=${refused} failed=${failed}`);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
