#!/usr/bin/env node
/**
 * exportBriefingSegments.js — slice a single iOS screen recording of
 * a briefing playback into per-segment MP4s, using segment start_ms
 * timestamps stored in the briefing_episodes row.
 *
 * Workflow:
 *   1. Open the briefing on your phone in the morning
 *   2. iOS Control Center → Screen Record THROUGHOUT the briefing
 *   3. AirDrop / save the recording to your laptop
 *   4. Run this CLI: it asks the DB for the segment timing map and
 *      ffmpeg-slices the recording into seg-1.mp4, seg-2.mp4, ...
 *
 * Why a manual workflow instead of automating with Playwright:
 *   - Captures the REAL production app, exactly as users see it
 *   - No auth-state plumbing, no Three.js coupling, no server-side
 *     dependency on a headless Chromium binary
 *   - Faster to validate whether per-segment briefing clips actually
 *     perform on social before investing 5+ hours in full automation
 *
 * Output: media/briefing-clips/<episode_id>/seg-<N>.mp4
 *       + media/briefing-clips/<episode_id>/manifest.json
 *
 * Manifest has `post: false` per segment + per-platform flags. Flip
 * the ones you want to publish; a future poster script reads the
 * manifest to publish them.
 *
 * Usage:
 *   node scripts/exportBriefingSegments.js \
 *     --episode=40 \
 *     --recording=/path/to/screen-record.mp4
 *
 *   # If your recording has lead-in before the briefing actually
 *   # starts playing, pass --offset=SECONDS:
 *   node scripts/exportBriefingSegments.js \
 *     --episode=40 --recording=record.mp4 --offset=3.5
 *
 *   # Subset of segments:
 *   node scripts/exportBriefingSegments.js \
 *     --episode=40 --recording=record.mp4 --only=1,3,5
 *
 *   # Force re-encode (cleaner cuts; default is fast stream-copy):
 *   node scripts/exportBriefingSegments.js \
 *     --episode=40 --recording=record.mp4 --reencode
 *
 *   # Crop iOS chrome (status bar / home indicator). Pass crop spec
 *   # in ffmpeg crop filter format: W:H:X:Y. Example for iPhone 16 Pro
 *   # raw screen record (1320×2868) → trim 80px status bar at top,
 *   # 36px home indicator at bottom:
 *   node scripts/exportBriefingSegments.js \
 *     --episode=40 --recording=record.mp4 --crop=1320:2752:0:80
 *
 * Server-side only. No Capacitor, no Xcode, no Apple. Pure Node CLI.
 */

'use strict';

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });

const fs    = require('fs');
const path  = require('path');
const { spawnSync } = require('child_process');
const pool  = require('../db');

// ─── CLI parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.+))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv);

if (!args.recording) {
  console.error('Missing --recording=PATH to your screen-record MP4');
  process.exit(1);
}
if (!fs.existsSync(args.recording)) {
  console.error(`Recording not found: ${args.recording}`);
  process.exit(1);
}

// ─── DB fetch ────────────────────────────────────────────────────────────
async function fetchEpisode() {
  let row;
  if (args.episode) {
    const epId = parseInt(args.episode, 10);
    const { rows } = await pool.query(
      `SELECT id, target_date, headline, segments, status
         FROM briefing_episodes WHERE id = $1`,
      [epId],
    );
    row = rows[0];
  } else {
    const date = typeof args.date === 'string'
      ? args.date
      : new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT id, target_date, headline, segments, status
         FROM briefing_episodes
        WHERE user_id IS NULL AND target_date = $1 AND status = 'ready'
        ORDER BY id DESC LIMIT 1`,
      [date],
    );
    row = rows[0];
  }
  if (!row) throw new Error('No matching briefing episode found');
  if (typeof row.segments === 'string') row.segments = JSON.parse(row.segments);
  return row;
}

async function fetchPrimaryNations(threadIds) {
  if (!threadIds.length) return {};
  const { rows } = await pool.query(
    `SELECT id, primary_nations, secondary_nations
       FROM story_threads WHERE id = ANY($1::int[])`,
    [threadIds],
  );
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      primary:   Array.isArray(r.primary_nations)   ? r.primary_nations   : [],
      secondary: Array.isArray(r.secondary_nations) ? r.secondary_nations : [],
    };
  }
  return out;
}

// ─── ffmpeg slice ────────────────────────────────────────────────────────
// Two modes:
//   - stream-copy (default): -c copy is ~10× faster but cuts at the
//     nearest keyframe so segment boundaries may shift by 0-2 seconds.
//     Fine for social clips where the narration is the time anchor.
//   - reencode: frame-accurate cuts at the cost of ~30s per segment
//     and a fresh H.264 encode.
function sliceRecording({ recordingPath, startSec, durationSec, outPath, reencode, cropSpec }) {
  const args = ['-y'];
  // -ss BEFORE -i for fast seek (uses container index, less accurate);
  // for re-encode mode put -ss AFTER -i so ffmpeg decodes precisely.
  if (!reencode) {
    args.push('-ss', String(startSec));
    args.push('-i', recordingPath);
    args.push('-t', String(durationSec));
    args.push('-c', 'copy');
    args.push('-avoid_negative_ts', 'make_zero');
  } else {
    args.push('-i', recordingPath);
    args.push('-ss', String(startSec));
    args.push('-t', String(durationSec));
    if (cropSpec) {
      args.push('-vf', `crop=${cropSpec},setsar=1`);
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2', '-crf', '20', '-r', '30');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  }
  args.push('-movflags', '+faststart');
  args.push(outPath);

  const res = spawnSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed:\n${res.stderr?.toString().split('\n').slice(-10).join('\n')}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Fetching episode…`);
  const ep = await fetchEpisode();
  const allSegments = ep.segments.filter(s => s && s.start_ms != null);
  if (!allSegments.length) throw new Error('Episode has no segments with start_ms');

  const dateStr = ep.target_date instanceof Date
    ? ep.target_date.toISOString().slice(0, 10)
    : String(ep.target_date).slice(0, 10);

  const outDir = path.join(__dirname, '..', 'media', 'briefing-clips', String(ep.id));
  fs.mkdirSync(outDir, { recursive: true });

  // CLI options
  const offsetSec  = args.offset  ? parseFloat(args.offset)  : 0;
  const reencode   = !!args.reencode;
  const cropSpec   = typeof args.crop === 'string' ? args.crop : null;
  const onlySet = typeof args.only === 'string'
    ? new Set(args.only.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite))
    : null;

  if (cropSpec && !reencode) {
    console.warn('⚠  --crop only applies with --reencode (stream-copy cannot apply filters); ignoring crop.');
  }

  console.log(`Episode ${ep.id} (${dateStr}) — ${ep.headline}`);
  console.log(`Recording: ${args.recording}`);
  console.log(`Offset: ${offsetSec}s   Mode: ${reencode ? 'reencode' : 'stream-copy'}${cropSpec && reencode ? `   Crop: ${cropSpec}` : ''}`);
  console.log();

  const threadIds = [...new Set(allSegments.map(s => s.thread_id).filter(Number.isFinite))];
  const nationsByThread = await fetchPrimaryNations(threadIds);

  const manifestEntries = [];
  let okCount = 0, skipCount = 0, failCount = 0;

  for (let i = 0; i < allSegments.length; i++) {
    if (onlySet && !onlySet.has(i)) { skipCount++; continue; }
    const seg = allSegments[i];
    if (seg.type !== 'story') {
      console.log(`[${i}] ${seg.type} — skipping (not a story segment)`);
      skipCount++;
      continue;
    }

    const nextSeg = allSegments[i + 1];
    const startMs = seg.start_ms;
    const endMs   = nextSeg?.start_ms ?? (seg.start_ms + 30000);
    const durationMs = Math.max(2000, endMs - startMs);

    const startSec    = (startMs / 1000) + offsetSec;
    const durationSec = durationMs / 1000;

    const outPath = path.join(outDir, `seg-${i}.mp4`);
    const nations = nationsByThread[seg.thread_id] || { primary: [], secondary: [] };

    try {
      sliceRecording({
        recordingPath: args.recording,
        startSec,
        durationSec,
        outPath,
        reencode,
        cropSpec,
      });
      const stat = fs.statSync(outPath);
      console.log(`[${i}] ✓ ${startSec.toFixed(1)}s + ${durationSec.toFixed(1)}s → ${(stat.size / 1024 / 1024).toFixed(2)} MB — "${(seg.thread_title || '').slice(0, 60)}"`);
      okCount++;

      manifestEntries.push({
        segment_index:     i,
        thread_id:         seg.thread_id,
        thread_title:      seg.thread_title,
        primary_nations:   nations.primary,
        secondary_nations: nations.secondary,
        start_sec:         Number(startSec.toFixed(3)),
        duration_sec:      Number(durationSec.toFixed(3)),
        clip_file:         path.basename(outPath),
        narration:         (seg.voiceover_text || seg.voiceover_before_video || '').trim(),
        media_type:        seg.media_type || 'composite',
        post:              false,
        post_targets: {
          twitter:   false,
          instagram: false,
          linkedin:  false,
          bluesky:   false,
        },
      });
    } catch (err) {
      console.log(`[${i}] ✗ ${err.message.split('\n')[0]}`);
      failCount++;
    }
  }

  const manifest = {
    episode_id:      ep.id,
    target_date:     dateStr,
    headline:        ep.headline,
    source_recording: path.resolve(args.recording),
    source_offset_sec: offsetSec,
    generated_at:    new Date().toISOString(),
    segment_count:   manifestEntries.length,
    segments:        manifestEntries,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log();
  console.log(`Done. ok=${okCount} skipped=${skipCount} failed=${failCount}`);
  console.log(`Output: ${outDir}`);
  console.log(`Manifest: ${path.join(outDir, 'manifest.json')}`);
  console.log();
  console.log(`To curate: edit manifest.json, set "post": true for segments you want to publish.`);
  await pool.end();
})().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
