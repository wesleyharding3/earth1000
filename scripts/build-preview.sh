#!/usr/bin/env bash
# build-preview.sh — assemble the final App Store App Preview video.
#
# Inputs (from media/):
#   intro.mp4              5.5s, 1290×2796 — branded opener
#   clip_01_globe.mov      raw simulator, 1320×2868 — hero globe
#   clip_02_arcs.mov       raw simulator, 1320×2868 — flow arcs
#   clip_03_country.mov    raw simulator, 1320×2868 — country panel reveal
#   clip_04_city.mov       raw simulator, 1320×2868 — city panel reveal
#   clip_05_thread.mov     raw simulator, 1320×2868 — threads grid + detail
#   clip_06_timeline.mov   raw simulator, 1320×2868 — line activity chart + events
#   outro.mp4              3.5s, 1290×2796 — branded close
#   www/audio/briefing/morse-room-signal.mp3 — background music
#
# Trim windows below pick the strongest ~3.5s of each raw clip. Adjust
# `START` values if you want to re-trim a beat. Each beat is exactly
# 3.5s so totals stay deterministic: 5.5 + 6*3.5 + 3.5 = 30s.
#
# Output: media/app_preview.mp4
#   1290×2796, 30fps, H.264 high@4.2, yuv420p, AAC 192kbps stereo,
#   ~30s, faststart muxed. App Store Connect accepts this directly as
#   an iPhone 6.9" App Preview.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT=media/app_preview.mp4
MUSIC=www/audio/briefing/morse-room-signal.mp3

# Per-clip trim windows: START in seconds, length always 3.5s.
# These were picked by inspecting frames from each raw capture and
# choosing the moment with peak readability + motion.
START_01=2.0   # clip 01: globe settled, markers pulsing
START_02=4.0   # clip 02: arcs fully drawn
START_03=4.0   # clip 03: country panel just landed, articles visible
START_04=5.5   # clip 04: Milan panel fully expanded (skips slide-up animation)
START_05=1.0   # clip 05: threads grid fully populated
START_06=8.0   # clip 06: timeline detail w/ activity chart + events

# Audio: 30s of morse-room-signal, fade in 1.5s, fade out 1.5s. Mixed
# at 50% so quieter than full-loudness music — the visuals are the
# story, the music is mood.
ffmpeg -y \
  -i media/intro.mp4 \
  -i media/clip_01_globe.mov \
  -i media/clip_02_arcs.mov \
  -i media/clip_03_country.mov \
  -i media/clip_04_city.mov \
  -i media/clip_05_thread.mov \
  -i media/clip_06_timeline.mov \
  -i media/outro.mp4 \
  -i "$MUSIC" \
  -filter_complex "
    [0:v]trim=0:5.5,setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v0];
    [1:v]trim=${START_01}:$(echo "${START_01}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v1];
    [2:v]trim=${START_02}:$(echo "${START_02}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v2];
    [3:v]trim=${START_03}:$(echo "${START_03}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v3];
    [4:v]trim=${START_04}:$(echo "${START_04}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v4];
    [5:v]trim=${START_05}:$(echo "${START_05}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v5];
    [6:v]trim=${START_06}:$(echo "${START_06}+3.5" | bc),setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v6];
    [7:v]trim=0:3.5,setpts=PTS-STARTPTS,fps=30,scale=1290:2796:flags=lanczos,setsar=1[v7];
    [v0][v1][v2][v3][v4][v5][v6][v7]concat=n=8:v=1:a=0[outv];
    [8:a]atrim=0:30,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.5,afade=t=out:st=28.5:d=1.5,volume=0.45[outa]
  " \
  -map "[outv]" -map "[outa]" \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.2 -crf 18 -r 30 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart \
  "$OUT"

echo
echo "Done: $OUT"
ffprobe -v error -show_entries stream=width,height,r_frame_rate,codec_name,duration -show_entries format=duration,size -of default=noprint_wrappers=1 "$OUT"
