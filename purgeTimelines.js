#!/usr/bin/env node
'use strict';
/**
 * purgeTimelines.js — Nuclear reset for story_timelines
 *
 * Deletes ALL existing timelines and their article links, then
 * runs storyTimelineBuilder to rebuild from scratch using the
 * new 7-day thread graduation gate + entity anchoring + dedup.
 *
 * Usage:
 *   node purgeTimelines.js              — dry-run (shows counts)
 *   node purgeTimelines.js --confirm    — actually purge + rebuild
 *   node purgeTimelines.js --purge-only — purge without rebuilding
 */

require('dotenv').config();
const pool = require('./db');

const CONFIRM    = process.argv.includes('--confirm');
const PURGE_ONLY = process.argv.includes('--purge-only');

async function run() {
  // Show current state
  const { rows: [{ tl_count }] } = await pool.query(
    `SELECT COUNT(*)::int AS tl_count FROM story_timelines`
  );
  const { rows: [{ link_count }] } = await pool.query(
    `SELECT COUNT(*)::int AS link_count FROM story_timeline_articles`
  );

  console.log(`\nCurrent state: ${tl_count} timelines, ${link_count} article links`);

  if (!CONFIRM) {
    console.log(`\nDry run — pass --confirm to purge and rebuild.`);
    console.log(`  node purgeTimelines.js --confirm        — purge + rebuild`);
    console.log(`  node purgeTimelines.js --confirm --purge-only — purge only\n`);
    await pool.end();
    return;
  }

  console.log(`\nPurging all timelines...`);

  // Delete article links first (FK dependency)
  const { rowCount: linksDeleted } = await pool.query(
    `DELETE FROM story_timeline_articles`
  );
  console.log(`  Deleted ${linksDeleted} article links`);

  // Delete all timelines
  const { rowCount: tlDeleted } = await pool.query(
    `DELETE FROM story_timelines`
  );
  console.log(`  Deleted ${tlDeleted} timelines`);

  // Reset sequence so new IDs start clean
  try {
    await pool.query(`ALTER SEQUENCE story_timelines_id_seq RESTART WITH 1`);
    console.log(`  Reset ID sequence`);
  } catch (e) {
    // Sequence may not exist or have a different name — not fatal
  }

  console.log(`\nPurge complete.`);

  if (PURGE_ONLY) {
    console.log(`--purge-only: skipping rebuild.\n`);
    await pool.end();
    return;
  }

  // Rebuild
  console.log(`\nRebuilding timelines via storyTimelineBuilder...\n`);
  const { run: buildTimelines } = require('./storyTimelineBuilder');
  await buildTimelines();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
