#!/usr/bin/env bash
# build-preview-instagram.sh — re-render the App Preview as 1080×1920
# (true 9:16) for Instagram Reels / Stories + Stories-shaped uploads on
# TikTok / X / BlueSky etc.
#
# Why this exists: the Apple-spec master is 886×1920 (Apple's iPhone
# 6.9" App Preview dimensions, aspect 0.461). Instagram Reels/Stories
# expect 1080×1920 (aspect 0.5625). When IG ingests the 886-wide
# master, it scales to fit the 1080 width (886→1080, ~1.22× zoom) and
# crops the resulting 1080×2341 down to 1080×1920 — chopping ~211px off
# the top AND bottom of every frame. The intro wordmark gets clipped,
# the outro CTA gets clipped, every globe frame loses its poles.
#
# Fix: PAD the master horizontally to 1080 wide with black sidebars
# instead of letting IG zoom-crop. The phone-shaped content sits dead
# center, ~97px of black on each side. No vertical crop. Brand chrome
# fully visible end-to-end.
#
# Inputs:
#   media/app_preview.mp4    886×1920 master (built by build-preview.sh
#                            + the Apple-spec rescale step)
# Output:
#   media/app_preview_instagram.mp4    1080×1920, 30fps, H.264, AAC,
#                                       faststart muxed — drop-straight
#                                       -into IG Reels uploader.

set -euo pipefail

cd "$(dirname "$0")/.."

SRC=media/app_preview.mp4
BG=media/starfield-instagram-bg.png
OUT=media/app_preview_instagram.mp4

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run build-preview.sh + the Apple-spec rescale first." >&2
  exit 1
fi

# Regenerate the starfield background if it's missing or stale (older
# than the generator script). Keeps the brand consistent if the seed
# or star count is ever tuned.
if [ ! -f "$BG" ] || [ "$(dirname "$0")/build-starfield-bg.js" -nt "$BG" ]; then
  echo "Regenerating starfield background…"
  node "$(dirname "$0")/build-starfield-bg.js"
fi

# Pipeline:
#  [0:v]  starfield PNG, looped to cover the 30s video duration
#  [1:v]  the source app preview (886×1920)
#  scale=-2:1920 → scale source to fit height; even width for libx264
#  overlay=(W-w)/2:0 → center the preview horizontally inside the 1080-wide
#                     starfield frame (W is bg width, w is fg width)
#  shortest=1 → cut output to match the video (don't let the bg loop forever)
ffmpeg -y \
  -loop 1 -i "$BG" \
  -i "$SRC" \
  -filter_complex "
    [0:v]format=yuv420p[bg];
    [1:v]scale=-2:1920:flags=lanczos,setsar=1[fg];
    [bg][fg]overlay=(W-w)/2:0:shortest=1,format=yuv420p[outv]
  " \
  -map "[outv]" -map "1:a" \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.2 -crf 18 -r 30 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart \
  "$OUT"

echo
echo "Done: $OUT"
ffprobe -v error -show_entries stream=width,height,r_frame_rate,codec_name,duration -show_entries format=duration,size -of default=noprint_wrappers=1 "$OUT"
