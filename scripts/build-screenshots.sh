#!/usr/bin/env bash
# build-screenshots.sh — extract App Store screenshot stills from the
# captured simulator clips.
#
# Each frame is extracted at the moment of peak readability +
# composition, scaled from the iPhone 17 Pro Max native 1320×2868 to
# the App-Store-spec 1290×2796 (iPhone 6.9" tier — covers iPhone 16
# Pro Max and 17 Pro Max submissions). Output PNGs are RGB, no alpha,
# 72 DPI — App Store Connect uploads them directly without further
# encoding.
#
# Output: media/screenshots/<NN>_<name>.png

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR=media/screenshots
mkdir -p "$OUT_DIR"

# Extracts a single frame at TIMESTAMP from CLIP, scales to App-Store
# spec, writes PNG to NAME. Lanczos for crisp downscaling.
extract() {
  local clip=$1
  local timestamp=$2
  local name=$3
  ffmpeg -y -loglevel error \
    -ss "$timestamp" -i "$clip" \
    -frames:v 1 \
    -vf "scale=1290:2796:flags=lanczos,setsar=1" \
    -pix_fmt rgb24 \
    "$OUT_DIR/$name"
  echo "  → $OUT_DIR/$name"
}

# Screenshot 1: Globe + flow arcs (peak arc visibility)
extract media/clip_02_arcs.mov 6.0 01_globe_arcs.png

# Screenshot 2: Country panel reveal (UK with global headlines)
extract media/clip_03_country.mov 5.0 02_country.png

# Screenshot 3: City panel reveal (Milan with Italian sources)
extract media/clip_04_city.mov 6.0 03_city.png

# Screenshot 4: Threads grid (4 active storylines side-by-side)
extract media/clip_05_thread.mov 1.5 04_threads_grid.png

# Screenshot 5: Thread detail (single thread with multi-source articles)
extract media/clip_05_thread.mov 9.0 05_thread_detail.png

# Screenshot 6: Timeline / Line detail (activity chart + chronological
# events) — the showpiece.
extract media/clip_06_timeline.mov 10.0 06_timeline.png

echo
echo "Done — 6 PNGs at 1290×2796:"
ls -la "$OUT_DIR"/*.png | awk '{ printf "  %s   %s\n", $5, $9 }'
