/**
 * animatedCardRenderer.js — MP4 video render for animated carousel slides.
 *
 * Renders N PNG frames via shareImageGenerator.generateFrame (which
 * threads an `animation: { progress: 0..1 }` param through the SVG
 * templates), and pipes them into ffmpeg via stdin to produce an MP4
 * encoded with H.264 + yuv420p (universally compatible — IG, Threads,
 * TikTok, X, WhatsApp, iMessage).
 *
 * Why a frame-loop instead of an HTML+canvas pipeline:
 *   • No browser dependency on Render (no extra ~120MB for Chromium)
 *   • Deterministic — every frame at progress=p is reproducible byte-for-byte
 *   • Reuses the entire SVG template + brand-token + font infrastructure
 *     we already built for the still images
 *   • Cheap: 90 frames × ~40ms render = ~3.6s + ~1s encode ≈ 5s per slide
 *
 * Output specs (tuned for IG carousel video items):
 *   • 1080×1350 (4:5)
 *   • 30 fps
 *   • 3 s duration (90 frames)
 *   • H.264 high profile @ ~5 Mbps, yuv420p, faststart
 *   • Silent AAC audio track (IG sometimes rejects audio-less video items)
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const shareImg  = require('./shareImageGenerator');

// ── ffmpeg binary path ────────────────────────────────────────────────
// @ffmpeg-installer/ffmpeg ships a static binary that works on every
// platform Render supports (Linux x64) plus local Mac dev. Falls back
// to system `ffmpeg` if the installer package isn't loadable for some
// reason (shouldn't happen in production — it's in package.json).
let _ffmpegPath;
try {
  _ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (_) {
  _ffmpegPath = 'ffmpeg';
}

// ── Render parameters ────────────────────────────────────────────────
const DEFAULT_FPS         = 30;
// IG VIDEO_CAROUSEL items must have a *track* duration ≥ 3.0s strictly.
// ffmpeg's `-t 3.0` with image2pipe at 30fps produces 90 frames whose
// last pts is (90-1)/30 = 2.967s — IG reads that as <3s and rejects the
// whole carousel with error code 2207077 (Media upload has failed). 4.0s
// gives a comfortable margin: track lands at 3.967s, well over the cap.
const DEFAULT_DURATION_S  = 4.0;
const VIDEO_CACHE_MAX     = 16;
const FRAME_RENDER_TIMEOUT_MS = 30_000;

// In-process MP4 cache. Each video is ~500KB–2MB at 1080×1350 / 3s, so
// 16 buffered cards ≈ 8-32MB worst case. Render's small-tier container
// has 2GB RAM, so this is comfortably below the budget. Cache is keyed
// by entity.cacheKey so the IG publisher can request the same MP4
// repeatedly during container-creation polling without re-rendering.
const _mp4Cache = new Map();
function _cacheGet(key) {
  if (!_mp4Cache.has(key)) return null;
  const v = _mp4Cache.get(key);
  _mp4Cache.delete(key);
  _mp4Cache.set(key, v); // LRU touch
  return v;
}
function _cacheSet(key, buf) {
  _mp4Cache.set(key, buf);
  while (_mp4Cache.size > VIDEO_CACHE_MAX) {
    const oldest = _mp4Cache.keys().next().value;
    _mp4Cache.delete(oldest);
  }
}

/**
 * Spawn ffmpeg configured for the IG carousel pipeline. Returns the
 * child process plus a `done` promise that resolves with the concatenated
 * MP4 buffer or rejects on non-zero exit.
 *
 * Why a tmpfile output instead of pipe:1: the MP4 muxer writes its
 * moov atom (track index) at FILE END by default, then `-movflags
 * faststart` re-seeks back to the head to relocate it for streaming.
 * Neither operation works on a non-seekable pipe — ffmpeg errors out
 * with "muxer does not support non seekable output". Using a tmpfile
 * gives us a proper seekable output, and we just read the bytes back
 * into a Buffer afterward (one extra I/O hop for a ~1MB file).
 *
 * yuv420p (not 444) for codec-agnostic playback; silent AAC audio
 * track because some IG endpoints reject pure video without audio.
 */
function _spawnEncoder({ fps, durationS, width, height }) {
  const tmpDir = require('os').tmpdir();
  const tmpPath = path.join(tmpDir, `earth00-card-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);

  // Audio: portrait.mp3 (a 4s segment cut from the user's own wes.wav).
  // Same loop plays under every carousel slide — unified motif across
  // the post. Card duration matches the audio's 4s, so it plays exactly
  // one cycle with the file's own 50ms boundary fades hiding any seam.
  // Using the user's own audio (not AI-generated like the morse track
  // that Meta fingerprinted) so the upload won't get flagged.
  const audioPath = path.join(__dirname, 'audio', 'carousel', 'portrait.mp3');

  const args = [
    '-y',
    '-hide_banner', '-loglevel', 'error',
    // Image input (input 0): PNG frames over stdin.
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    // Audio input (input 1): portrait.mp3 loop. stream_loop -1 just for
    // safety in case durationS ever exceeds 4s.
    '-stream_loop', '-1',
    '-i', audioPath,
    '-map', '0:v',
    '-map', '1:a:0',
    // H.264 + AAC tuned to Meta carousel ingester requirements. Bitrate
    // alone (CRF 17 → ~2-3 Mbps) wasn't enough to clear 2207077; the
    // ingester was also rejecting MP4s with AAC-priming `elst` edit
    // list atoms. Below: Main profile (broader compat than High), closed
    // GOP with a keyframe every 2s, 48 kHz audio (Meta's preferred rate),
    // and `aresample=async=1:first_pts=0` to flatten AAC priming so no
    // `elst` is written. `-avoid_negative_ts make_zero` is belt+braces.
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-crf', '17',
    '-profile:v', 'main',
    '-level', '4.0',
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
    '-bf', '2',
    '-r', String(fps),
    '-video_track_timescale', '30000',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    // Disable mov-muxer's edit-list (elst) writes. Without this, ffmpeg
    // emits an `elst` atom for AAC priming offset, which the Meta
    // ingester rejects with error code 2207077.
    '-use_editlist', '0',
    '-t', String(durationS),
    // Output to a seekable tmpfile (see header rationale above).
    '-f', 'mp4',
    tmpPath,
  ];

  const child = spawn(_ffmpegPath, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.on('data', c => stderrChunks.push(c));

  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const buf = fs.readFileSync(tmpPath);
          fs.unlinkSync(tmpPath);
          resolve(buf);
        } catch (err) {
          reject(new Error(`tmpfile read failed: ${err.message}`));
        }
      } else {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        const msg = Buffer.concat(stderrChunks).toString('utf8').slice(0, 1000);
        reject(new Error(`ffmpeg exit ${code}: ${msg}`));
      }
    });
  });

  return { child, done };
}

/**
 * Render an animated MP4 for the given entity. Same entity contract as
 * shareImg.generate() but the kind MUST be an animated one:
 *   • 'thread-portrait'   — title typewriter + flag chip slide-in
 *   • 'thread-coverage'   — donut clockwise sweep + counter tween + legend stagger
 *   • 'thread-articles'   — staggered bar slide-ins from right
 *
 * Resolves with an MP4 Buffer. Cached by entity.cacheKey.
 */
async function generateVideo(entity, opts = {}) {
  const fps        = opts.fps       || DEFAULT_FPS;
  const durationS  = opts.durationS || DEFAULT_DURATION_S;
  const frameCount = Math.round(fps * durationS);

  // Cache check — cacheKey is required for caching to work.
  const cacheKey = entity.cacheKey;
  if (cacheKey) {
    const hit = _cacheGet(cacheKey);
    if (hit) return hit;
  }

  const t0 = Date.now();

  // Probe the first frame at progress=1 (final state) just to bubble
  // up any template-level errors (bad SVG, missing fonts, etc.) before
  // we spawn ffmpeg. Cheaper to fail here than to hang the encoder.
  await Promise.race([
    shareImg.generateFrame(entity, 1),
    new Promise((_, rej) => setTimeout(() => rej(new Error('frame probe timeout')), FRAME_RENDER_TIMEOUT_MS)),
  ]);

  // Pick canvas dims from the entity's aspect. Default 'portrait' = 4:5
  // (1080×1350) for the IG carousel. 'reel' = 9:16 (1080×1920) for the
  // stitched Reel pipeline. The dims need to match what shareImg's
  // generateFrame is going to emit, otherwise ffmpeg gets PNGs that
  // don't fit the encoder's declared size.
  const isReel = entity.aspect === 'reel';
  const width  = isReel ? shareImg.W_R : shareImg.W_P;
  const height = isReel ? shareImg.H_R : shareImg.H_P;

  // Spawn ffmpeg, then sequentially render & write each frame to stdin.
  const { child, done } = _spawnEncoder({
    fps, durationS,
    width, height,
  });

  let writeError = null;
  child.stdin.on('error', (err) => {
    // EPIPE here usually means ffmpeg exited early (e.g. bad input).
    // Stash the error so the loop below can break and surface ffmpeg's
    // stderr via the `done` promise.
    writeError = err;
  });

  // Cover-flash mode: render frame 0 at progress=1 (fully-drawn finished
  // state) before frames 1..N play the normal animation from
  // progress=0→1. Viewers see a tiny (~33ms at 30fps) flicker on
  // playback — near the threshold of human perception — but the
  // first frame is the polished, fully-loaded card.
  //
  // In CAROUSEL mode all 3 animated kinds get the flash: it gives the
  // IG VIDEO_CAROUSEL a polished cover thumbnail on slide 1 AND a
  // unified "every slide briefly previews itself" feel across slides
  // 3 and 4.
  //
  // In REEL mode, only the first slide (thread-portrait) gets the
  // flash. The Reel is one continuous video, so flashing the pie /
  // articles mid-playback reads as a glitch rather than a deliberate
  // preview. Portrait still flashes because it's the Reel's cover
  // thumbnail (IG uses frame 0 of the Reel video).
  const COVER_FLASH_KINDS = new Set([
    'thread-portrait',
    'thread-coverage',
    'thread-articles',
  ]);
  const isReelKind = entity.aspect === 'reel';
  const coverFlash = COVER_FLASH_KINDS.has(entity.kind) &&
                     (!isReelKind || entity.kind === 'thread-portrait');

  try {
    for (let i = 0; i < frameCount; i++) {
      if (writeError) break;
      let progress;
      if (coverFlash && i === 0) {
        progress = 1;
      } else if (coverFlash) {
        progress = (i - 1) / Math.max(1, frameCount - 2);
      } else {
        progress = i / Math.max(1, frameCount - 1);
      }
      const png = await shareImg.generateFrame(entity, progress);
      // Back-pressure aware write — pause the loop if stdin's buffer is
      // full until 'drain' fires, otherwise high-frame-count renders
      // can OOM the Node side waiting on ffmpeg to catch up.
      if (!child.stdin.write(png)) {
        await new Promise(res => child.stdin.once('drain', res));
      }
    }
  } finally {
    try { child.stdin.end(); } catch (_) { /* already closed */ }
  }

  const mp4 = await done;
  const elapsed = Date.now() - t0;
  console.log(`[anim-card] kind=${entity.kind} frames=${frameCount} → ${mp4.length} bytes in ${elapsed}ms`);

  if (cacheKey) _cacheSet(cacheKey, mp4);
  return mp4;
}

function bustCache(cacheKey) { _mp4Cache.delete(cacheKey); }

/**
 * Probe an MP4 file's duration in seconds. Parses ffmpeg's own
 * stderr instead of relying on ffprobe — @ffmpeg-installer doesn't
 * ship ffprobe so this works on Render too.
 */
function _probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(_ffmpegPath, ['-hide_banner', '-i', filePath, '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', reject);
    proc.on('close', () => {
      // Stderr contains a line like "Duration: 00:00:15.20, ..."
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error(`duration not found in stderr: ${stderr.slice(-300)}`));
      const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      resolve(sec);
    });
  });
}

/**
 * Stitch N MP4 buffers end-to-end into a single MP4. Each input is
 * scaled+padded into a `width × height` canvas (preserving aspect, with
 * black bars if needed), normalized to the same fps + audio sample rate,
 * then concatenated. Output uses the same H.264 + AAC + faststart +
 * no-edit-list settings as the carousel encoder so Meta's ingester
 * accepts it cleanly.
 *
 * Used by the Reels pipeline: portrait + arc + pie + articles → one
 * 1080×1920 vertical video.
 *
 * @param {Buffer[]} buffers — ordered MP4 buffers
 * @param {Object} opts —
 *   { width, height, fps, audioRate,
 *     musicPath?,   // optional: replace per-segment audios with one continuous
 *                   //   track from a single audio file (e.g. a wes.wav cut).
 *                   //   The track is trimmed to the total stitched-video
 *                   //   duration with an 0.8s fade-out at the end.
 *     musicStart?,  // optional: seconds into musicPath to start from (default 0)
 *   }
 * @returns {Promise<Buffer>}
 */
async function concatMp4s(buffers, opts = {}) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new Error('concatMp4s: need at least one input buffer');
  }
  const width      = opts.width      || 1080;
  const height     = opts.height     || 1920;
  const fps        = opts.fps        || 30;
  const audioRate  = opts.audioRate  || 48000;
  const musicPath  = opts.musicPath  || null;
  const musicStart = Number(opts.musicStart) || 0;

  const tmpDir = require('os').tmpdir();
  const stamp  = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const inputPaths = buffers.map((_, i) => path.join(tmpDir, `concat-${stamp}-in${i}.mp4`));
  const outPath    = path.join(tmpDir, `concat-${stamp}-out.mp4`);

  // Write all inputs
  for (let i = 0; i < buffers.length; i++) {
    fs.writeFileSync(inputPaths[i], buffers[i]);
  }

  // Build the filter_complex. For each input:
  //   [iv] = scale to fit within target then pad with black to target
  //   [ia] = resample audio to target rate, stereo
  // Then concat all of them.
  const N = buffers.length;
  const padScale = (idx) =>
    `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,fps=${fps},setpts=PTS-STARTPTS[v${idx}]`;
  const audioPrep = (idx) =>
    `[${idx}:a]aresample=${audioRate}:async=1:first_pts=0,asetpts=PTS-STARTPTS[a${idx}]`;

  let filter, args;
  if (musicPath) {
    // ── Music-override mode: ignore per-segment audios, replace with
    // a single trimmed cut from `musicPath` so the reel plays one
    // continuous soundtrack instead of a 4s loop per slide.
    //
    // Need total stitched duration to size the music. Probe each
    // input's duration via ffmpeg-stderr (works on Render where
    // ffprobe isn't installed).
    const segDurs = await Promise.all(inputPaths.map(_probeDurationSec));
    const totalDur = segDurs.reduce((a, b) => a + b, 0);
    const fadeStart = Math.max(0, totalDur - 0.8);

    // Video-only concat — labels are now just [v0][v1]...[vN-1].
    const videoLabels = Array.from({ length: N }, (_, i) => `[v${i}]`).join('');
    const concatStr   = `${videoLabels}concat=n=${N}:v=1:a=0[outv]`;

    // Music is input N (after the N video inputs). Trim to exact reel
    // duration; fade out 0.8s before the cut so it doesn't slam shut.
    const musicFilter =
      `[${N}:a]aresample=${audioRate}:async=1:first_pts=0,` +
      `atrim=duration=${totalDur.toFixed(3)},` +
      `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.8,` +
      `asetpts=PTS-STARTPTS[outa]`;

    filter = [
      ...buffers.map((_, i) => padScale(i)),
      concatStr,
      musicFilter,
    ].join(';');

    args = [
      '-y',
      '-hide_banner', '-loglevel', 'error',
      ...buffers.flatMap((_, i) => ['-i', inputPaths[i]]),
      ...(musicStart > 0 ? ['-ss', String(musicStart)] : []),
      '-i', musicPath,
      '-filter_complex', filter,
      '-map', '[outv]',
      '-map', '[outa]',
    ];
  } else {
    // ── Per-segment audio mode (legacy): each segment keeps its own
    // 4-second portrait.mp3 loop, concatenated alongside the video.
    // ffmpeg's concat filter requires INTERLEAVED stream labels —
    // [v0][a0][v1][a1]... — concatenating "all videos then all audios"
    // triggers a media-type-mismatch error.
    const interleaved = Array.from({ length: N }, (_, i) => `[v${i}][a${i}]`).join('');
    const concatStr   = `${interleaved}concat=n=${N}:v=1:a=1[outv][outa]`;

    filter = [
      ...buffers.map((_, i) => padScale(i)),
      ...buffers.map((_, i) => audioPrep(i)),
      concatStr,
    ].join(';');

    args = [
      '-y',
      '-hide_banner', '-loglevel', 'error',
      ...buffers.flatMap((_, i) => ['-i', inputPaths[i]]),
      '-filter_complex', filter,
      '-map', '[outv]',
      '-map', '[outa]',
    ];
  }

  // Encoder settings — identical in both modes (Meta-acceptance fix).
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-crf', '17',
    '-profile:v', 'main',
    '-level', '4.0',
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
    '-bf', '2',
    '-r', String(fps),
    '-video_track_timescale', '30000',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', String(audioRate),
    '-ac', '2',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-use_editlist', '0',
    '-f', 'mp4',
    outPath,
  );

  const proc = spawn(_ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderrChunks = [];
  proc.stderr.on('data', c => stderrChunks.push(c));
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const msg = Buffer.concat(stderrChunks).toString('utf8').slice(0, 1500);
      reject(new Error(`ffmpeg concat exit ${code}: ${msg}`));
    });
  });
  const buf = fs.readFileSync(outPath);
  // Best-effort cleanup; safe even if a path failed mid-write.
  for (const p of [...inputPaths, outPath]) {
    try { fs.unlinkSync(p); } catch (_) { /* noop */ }
  }
  console.log(`[anim-card] concat ${N} clips → ${buf.length} bytes in ${Date.now() - t0}ms`);
  return buf;
}

module.exports = { generateVideo, concatMp4s, bustCache };
