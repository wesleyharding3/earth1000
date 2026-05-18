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
    // H.264 video, yuv420p for universal player compat. CRF 17 (was 22) —
    // pushes the encoded video bitrate up from ~500 kbps to ~2-3 Mbps so
    // IG carousel-item validation passes (lower-bitrate items had been
    // failing with the generic error code 2207077; arc at 3.3 Mbps
    // passes REELS fine, so the bitrate floor is plausible).
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-crf', '17',
    '-profile:v', 'high',
    '-movflags', '+faststart',
    '-r', String(fps),
    '-t', String(durationS),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
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

  // Spawn ffmpeg, then sequentially render & write each frame to stdin.
  const { child, done } = _spawnEncoder({
    fps, durationS,
    width: shareImg.W_P, height: shareImg.H_P,
  });

  let writeError = null;
  child.stdin.on('error', (err) => {
    // EPIPE here usually means ffmpeg exited early (e.g. bad input).
    // Stash the error so the loop below can break and surface ffmpeg's
    // stderr via the `done` promise.
    writeError = err;
  });

  // Cover-flash mode: IG VIDEO_CAROUSEL uses the first frame of the
  // first carousel item as the post's cover thumbnail. If the portrait
  // card animates in from blank, the cover ends up a half-rendered
  // mess. By rendering frame 0 at progress=1 (fully-drawn finished
  // state), the cover thumbnail is the polished card. Frames 1..N then
  // play the normal animation from progress=0→1 — viewers see a tiny
  // (~33ms at 30fps) flicker on playback, near the threshold of human
  // perception. Only applied to 'thread-portrait' (= slide 1 of the IG
  // carousel) since the other kinds aren't the cover.
  const coverFlash = entity.kind === 'thread-portrait';

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

module.exports = { generateVideo, bustCache };
