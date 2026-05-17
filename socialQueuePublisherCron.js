#!/usr/bin/env node
/**
 * socialQueuePublisherCron.js — publishes queue rows once they're
 * eligible. Runs every 15 min on Render Cron.
 *
 * Eligibility rules (in order):
 *   1. Row is in status 'pending_approval' OR 'approved'
 *   2. EITHER the video MP4 exists at /tmp/arc-cache/{thread_id}.mp4
 *      OR the row has been pending for more than STALE_THRESHOLD_H
 *      (fallback: publish image-only)
 *   3. We haven't already exceeded MAX_PUBLISHES_PER_DAY today
 *      (rate limit so a vacation-backlog catch-up doesn't fire 20
 *       posts in 15 min)
 *
 * When all three pass, the row gets pushed through socialPublishers
 * .publishAll() and its status flips to 'posted' (or 'failed').
 *
 * Schedule: every 15 min via Render Cron — `0,15,30,45 * * * *`
 */

'use strict';

process.env.DB_POOL_MAX = '2';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('./db');
const socialPublishers = require('./publishers');

const TAG = '[socialPublisher]';
const DRY_RUN = process.argv.includes('--dry-run');

// Tuning constants
const MAX_PUBLISHES_PER_RUN = 1;     // 1 per 15-min run → max 96/day theoretical, but rate-limited below
const MAX_PUBLISHES_PER_DAY = 4;     // hard daily cap (twice-daily picker × 2 windows = ~6 max threads/day, 4 published is healthy)
const STALE_THRESHOLD_H     = 48;    // after 48h, publish image-only even without video
const VIDEO_CACHE_DIR       = '/tmp/arc-cache';

const log  = (m) => console.log(`${TAG} ${m}`);
const warn = (m) => console.warn(`${TAG} ${m}`);

function _hasVideoFor(threadId) {
  try {
    const p = path.join(VIDEO_CACHE_DIR, `${threadId}.mp4`);
    const stat = fs.statSync(p);
    return stat.size > 1000;
  } catch (_) { return false; }
}

(async () => {
  const t0 = Date.now();

  // Today-window publish count (uses posted_at, which is set on success)
  const { rows: [{ count }] } = await pool.query(`
    SELECT COUNT(*)::int AS count
      FROM social_post_queue
     WHERE status = 'posted'
       AND posted_at > DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `);
  const publishedToday = Number(count) || 0;
  log(`Published today: ${publishedToday} / ${MAX_PUBLISHES_PER_DAY}`);
  if (publishedToday >= MAX_PUBLISHES_PER_DAY) {
    log('Daily cap reached. Exiting.');
    await pool.end();
    return;
  }

  // Find eligible rows. Three conditions:
  //   1. status in ('pending_approval', 'approved')
  //   2. video exists OR row older than STALE_THRESHOLD_H
  //   3. ordered by oldest first so backlog drains FIFO
  const { rows: candidates } = await pool.query(`
    SELECT id, thread_id, drafts, platforms_enabled, scheduled_for, status,
           EXTRACT(EPOCH FROM (NOW() - scheduled_for))::int AS age_seconds
      FROM social_post_queue
     WHERE status IN ('pending_approval', 'approved')
     ORDER BY scheduled_for ASC
     LIMIT 20
  `);

  if (!candidates.length) {
    log('No eligible rows. Exiting.');
    await pool.end();
    return;
  }

  let publishedThisRun = 0;
  let remainingCap = MAX_PUBLISHES_PER_DAY - publishedToday;

  for (const row of candidates) {
    if (publishedThisRun >= MAX_PUBLISHES_PER_RUN) break;
    if (publishedThisRun >= remainingCap) break;

    const hasVideo = _hasVideoFor(row.thread_id);
    const ageHours = (row.age_seconds || 0) / 3600;
    const isStale  = ageHours > STALE_THRESHOLD_H;

    if (!hasVideo && !isStale) {
      log(`  thread=${row.thread_id} age=${ageHours.toFixed(1)}h NO video, NOT stale → wait`);
      continue;
    }

    const reason = hasVideo ? 'video-ready' : 'stale-image-only';
    console.log(`\n  [publishing] queue_id=${row.id} thread=${row.thread_id} reason=${reason} age=${ageHours.toFixed(1)}h`);

    if (DRY_RUN) {
      publishedThisRun++;
      continue;
    }

    try {
      const { permalinks, failures } = await socialPublishers.publishAll(
        row.drafts || {},
        row.platforms_enabled || {},
        process.env,
      );
      const anySuccess = Object.keys(permalinks).length > 0;
      const nextStatus = anySuccess ? 'posted' : (failures.length ? 'failed' : 'approved');

      await pool.query(`
        UPDATE social_post_queue
           SET status      = $1,
               posted_at   = CASE WHEN $5::boolean THEN NOW() ELSE posted_at END,
               permalinks  = COALESCE(permalinks, '{}'::jsonb) || $2::jsonb,
               failure_log = failure_log || $3::jsonb
         WHERE id = $4
      `, [
        nextStatus,
        JSON.stringify(permalinks),
        JSON.stringify(failures.map(f => ({ ...f, attempted_at: new Date().toISOString() }))),
        row.id,
        anySuccess,
      ]);

      console.log(`         → ${nextStatus}  permalinks=${Object.keys(permalinks).join(',') || 'none'}  failures=${failures.length}`);
      if (failures.length) {
        for (const f of failures) console.log(`             ✗ ${f.platform}: ${f.error}`);
      }
      if (anySuccess) publishedThisRun++;
    } catch (err) {
      warn(`publish failed for queue_id=${row.id}: ${err.message}`);
    }
  }

  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Published ${publishedThisRun} row${publishedThisRun === 1 ? '' : 's'}${DRY_RUN ? ' (dry-run)' : ''}.`);
  await pool.end();
})().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
