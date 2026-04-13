#!/usr/bin/env node
'use strict';
/**
 * timelineAudit.js — One-time audit and restructure of story_timelines.
 *
 * 1. Merge duplicate/near-duplicate timelines
 * 2. Absorb sub-arcs into parent umbrella timelines
 * 3. Rename overly specific titles to broad umbrella names
 * 4. Delete noise timelines (≤2 articles, no clear arc)
 * 5. Re-scope slugs to be clean and broad
 * 6. Refresh all article counts
 *
 * Run once:  node timelineAudit.js
 * Safe to re-run — idempotent.
 */

require('dotenv').config();
const pool = require('./db');

const TAG = '[timelineAudit]';

// ═════════════════════════════════════════════════════════════════════════════
//  MERGE MAP — source timeline IDs → target timeline ID
//  Articles from source get moved to target, then source is deleted.
// ═════════════════════════════════════════════════════════════════════════════
const MERGE_MAP = {
  // North Korea duplicates → merge into one
  225: 179,  // "North Korea Escalation" → "Korea Military Tensions"

  // India-Pakistan duplicates
  238: 201,  // "India-Pakistan Crisis" → "India-Pakistan Tensions"

  // Russia Alliance duplicates
  196: 232,  // "Russia Alliance Collapse" → "Russia Alliance Deterioration"

  // Ukraine Child Recovery duplicates → absorb into Russia-Ukraine War
  198: 190,  // "Ukraine Child Recovery" → "Russia-Ukraine War"
  236: 190,  // "Ukraine Child Recovery Aid" → "Russia-Ukraine War"

  // Iran sub-arcs → absorb into Iran-Israel main arc
  169: 168,  // "Iran Leadership Transition" → "Iran-Israel Escalation"
  193: 168,  // "Iran Cyber Espionage" → "Iran-Israel Escalation"
  185: 168,  // "Iran Nordic Security Threat" → "Iran-Israel Escalation"

  // Russia sub-arcs → absorb into Russia-Ukraine War
  191: 190,  // "Russia Intelligence Breach" → "Russia-Ukraine War"
  195: 190,  // "US-Russia Diplomacy" → "Russia-Ukraine War"
  247: 190,  // "Russia Economic Strain" → "Russia-Ukraine War"
  176: 190,  // "Turkish Stream Sabotage" → "Russia-Ukraine War"

  // Israel-Lebanon → could stand alone or merge into broader Middle East
  // Keep separate for now — it's a distinct arc

  // "Ceasefire Economic Impact" is vague — check what it actually covers
  // We'll handle via rename if articles are Gaza/Israel related

  // Eastern Europe Winter Crisis → could merge into Russia-Ukraine context
  199: 190,  // "Eastern Europe Winter Crisis" → "Russia-Ukraine War"

  // Belarus-North Korea → merge into North Korea arc
  204: 179,  // "Belarus-North Korea Ties" → "Korea Military Tensions"
};

// ═════════════════════════════════════════════════════════════════════════════
//  RENAME MAP — timeline ID → new { title, scope }
// ═════════════════════════════════════════════════════════════════════════════
const RENAME_MAP = {
  168: { title: 'Iran Israel War',            scope: 'iran_israel' },
  190: { title: 'Russia Ukraine War',         scope: 'russia_ukraine' },
  170: { title: 'Global Climate Crisis',      scope: 'climate_crisis' },
  172: { title: 'Global Organized Crime',     scope: 'organized_crime' },
  179: { title: 'North Korea',                scope: 'north_korea' },
  219: { title: 'NATO',                       scope: 'nato' },
  244: { title: 'Venezuela Crisis',           scope: 'venezuela' },
  242: { title: 'Sudan Civil War',            scope: 'sudan' },
  243: { title: 'Myanmar Civil War',          scope: 'myanmar' },
  245: { title: 'US Drought Crisis',          scope: 'us_drought' },
  249: { title: 'Canada Wildfires',           scope: 'canada_wildfires' },
  250: { title: 'Global Food Security',       scope: 'food_security' },
  215: { title: 'Middle East Ceasefire',      scope: 'middle_east_ceasefire' },
  216: { title: 'Israel Lebanon Conflict',    scope: 'israel_lebanon' },
  217: { title: 'Jerusalem Crisis',           scope: 'jerusalem' },
  234: { title: 'EU Espionage Crisis',        scope: 'eu_espionage' },
  173: { title: 'AI Regulation',              scope: 'ai_regulation' },
  194: { title: 'Global Protest Movements',   scope: 'global_protests' },
  211: { title: 'European Elections',          scope: 'european_elections' },
  171: { title: 'Cuba Crisis',                scope: 'cuba' },
  201: { title: 'India Pakistan Tensions',    scope: 'india_pakistan' },
  232: { title: 'Russia Alliances',           scope: 'russia_alliances' },
  200: { title: 'Brazil Political Crisis',    scope: 'brazil' },
  189: { title: 'US China Relations',         scope: 'us_china' },
  178: { title: 'US Border Crisis',           scope: 'us_border' },
  182: { title: 'Haiti Crisis',               scope: 'haiti' },
  177: { title: 'DRC Rwanda Conflict',        scope: 'drc_rwanda' },
  174: { title: 'Space Exploration',          scope: 'space' },
  212: { title: 'Turkey Political Crisis',    scope: 'turkey' },
  210: { title: 'Armenia Crisis',             scope: 'armenia' },
  209: { title: 'Somalia Crisis',             scope: 'somalia' },
  202: { title: 'Mexico Trade',               scope: 'mexico_trade' },
  208: { title: 'Central Asia Energy',        scope: 'central_asia_energy' },
  207: { title: 'Nepal Politics',             scope: 'nepal' },
  248: { title: 'US Supreme Court',           scope: 'us_supreme_court' },
  183: { title: 'Syria Reconstruction',       scope: 'syria' },
};

// ═════════════════════════════════════════════════════════════════════════════
//  DELETE LIST — tiny noise timelines (≤2 articles, no ongoing arc)
// ═════════════════════════════════════════════════════════════════════════════
const DELETE_IDS = [
  180, // "US Labor Market Growth" — 2 articles, not a geopolitical arc
  184, // "Illegal Gambling Crackdown" — 2 articles, local crime
  186, // "Azerbaijan Georgia Diplomacy" — 4 articles, too niche
  187, // "Argentina Malvinas Dispute" — 3 articles, dormant issue
  181, // "US Conversion Therapy Ruling" — 3 articles, domestic policy
  197, // "White House Insider Trading" — 3 articles, domestic scandal
  205, // "Hungary Police Whistleblower" — 5 articles, local
  206, // "Latvia IT Corruption" — 4 articles, local scandal
];

// ═════════════════════════════════════════════════════════════════════════════
//  EXECUTION
// ═════════════════════════════════════════════════════════════════════════════
async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;
  console.log(`\n${TAG} Starting timeline audit — ${new Date().toISOString()}\n`);

  // ── Step 1: Merge duplicates ──────────────────────────────────────────────
  console.log(`${TAG} Step 1: Merging ${Object.keys(MERGE_MAP).length} timelines...`);
  let mergeCount = 0;
  for (const [sourceId, targetId] of Object.entries(MERGE_MAP)) {
    try {
      // Check both exist
      const { rows: check } = await pool.query(
        'SELECT id FROM story_timelines WHERE id = ANY($1::int[])',
        [[Number(sourceId), Number(targetId)]]
      );
      if (check.length < 2) {
        // Source may already be deleted from a previous run
        if (!check.find(r => Number(r.id) === Number(sourceId))) continue;
        console.log(`   ⚠ Target ${targetId} not found for source ${sourceId} — skipping`);
        continue;
      }

      // Move articles from source to target (skip duplicates)
      const { rowCount: moved } = await pool.query(`
        INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
        SELECT $1, article_id, parabolic_weight, relevance_score, is_anchor
        FROM story_timeline_articles
        WHERE timeline_id = $2
          AND article_id NOT IN (SELECT article_id FROM story_timeline_articles WHERE timeline_id = $1)
      `, [Number(targetId), Number(sourceId)]);

      // Merge keywords
      await pool.query(`
        UPDATE story_timelines
        SET keywords = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(
              keywords || COALESCE((SELECT keywords FROM story_timelines WHERE id = $2), ARRAY[]::text[])
            )
          )
        )
        WHERE id = $1
      `, [Number(targetId), Number(sourceId)]);

      // Delete source articles and timeline
      await pool.query('DELETE FROM story_timeline_articles WHERE timeline_id = $1', [Number(sourceId)]);
      await pool.query('DELETE FROM story_timelines WHERE id = $1', [Number(sourceId)]);

      const { rows: srcInfo } = await pool.query('SELECT title FROM story_timelines WHERE id = $1', [Number(targetId)]);
      console.log(`   ✓ Merged #${sourceId} → #${targetId} (${srcInfo[0]?.title}) — ${moved} articles moved`);
      mergeCount++;
    } catch (err) {
      console.error(`   ⚠ Merge ${sourceId}→${targetId} failed: ${err.message}`);
    }
  }
  console.log(`   ${mergeCount} merges completed\n`);

  // ── Step 2: Rename titles and scopes ──────────────────────────────────────
  console.log(`${TAG} Step 2: Renaming ${Object.keys(RENAME_MAP).length} timelines...`);
  let renameCount = 0;
  for (const [id, { title, scope }] of Object.entries(RENAME_MAP)) {
    try {
      const { rowCount } = await pool.query(`
        UPDATE story_timelines SET title = $1, scope = $2 WHERE id = $3
      `, [title, scope, Number(id)]);
      if (rowCount > 0) {
        renameCount++;
      }
    } catch (err) {
      // Scope conflict — another timeline already has this scope
      if (err.code === '23505') {
        // Try just renaming the title
        await pool.query('UPDATE story_timelines SET title = $1 WHERE id = $2', [title, Number(id)]);
        console.log(`   ⚠ Scope "${scope}" already taken for #${id} — renamed title only`);
        renameCount++;
      } else {
        console.error(`   ⚠ Rename #${id} failed: ${err.message}`);
      }
    }
  }
  console.log(`   ${renameCount} renames completed\n`);

  // ── Step 3: Delete noise timelines ────────────────────────────────────────
  console.log(`${TAG} Step 3: Deleting ${DELETE_IDS.length} noise timelines...`);
  let deleteCount = 0;
  for (const id of DELETE_IDS) {
    try {
      await pool.query('DELETE FROM story_timeline_articles WHERE timeline_id = $1', [id]);
      const { rowCount } = await pool.query('DELETE FROM story_timelines WHERE id = $1', [id]);
      if (rowCount > 0) deleteCount++;
    } catch (err) {
      console.error(`   ⚠ Delete #${id} failed: ${err.message}`);
    }
  }
  console.log(`   ${deleteCount} deleted\n`);

  // ── Step 4: Refresh all article counts ────────────────────────────────────
  console.log(`${TAG} Step 4: Refreshing article counts...`);
  await pool.query(`
    UPDATE story_timelines t
    SET article_count       = COALESCE(sub.cnt, 0),
        distinct_source_count = COALESCE(sub.src_cnt, 0),
        parabolic_weight_sum = COALESCE(sub.pw_sum, 0)
    FROM (
      SELECT sta.timeline_id,
             COUNT(*)::int AS cnt,
             COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS src_cnt,
             COALESCE(SUM(sta.parabolic_weight)::real, 0) AS pw_sum
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      GROUP BY sta.timeline_id
    ) sub
    WHERE t.id = sub.timeline_id
  `);
  console.log(`   Done\n`);

  // ── Step 5: Mark all remaining as active (they'll get real status from the builder) ──
  console.log(`${TAG} Step 5: Resetting all timelines to active...`);
  await pool.query(`UPDATE story_timelines SET status = 'active', last_updated_at = NOW()`);
  console.log(`   Done\n`);

  // ── Final summary ────────────────────────────────────────────────────────
  const { rows: final } = await pool.query(`
    SELECT id, title, scope, article_count, importance
    FROM story_timelines
    ORDER BY article_count DESC
  `);
  console.log(`${TAG} Final state: ${final.length} timelines\n`);
  console.log('ID   | ARTICLES | IMP | TITLE                          | SCOPE');
  console.log('-----|----------|-----|--------------------------------|------');
  for (const r of final) {
    console.log(
      `${String(r.id).padStart(4)} | ${String(r.article_count).padStart(8)} | ${String(r.importance).padStart(3)} | ${(r.title || '').padEnd(30).slice(0,30)} | ${r.scope || '—'}`
    );
  }

  console.log(`\n${TAG} Done in ${elapsed()}. Now run: node storyTimelineBuilder.js\n`);
  await pool.end();
}

run().catch(err => {
  console.error(`${TAG} Fatal:`, err);
  process.exit(1);
});
