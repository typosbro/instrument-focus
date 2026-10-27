#!/usr/bin/env bash
# Turn two screen recordings into the reel's media and analysis data.
#   flat:  the song playing normally, extension off
#   demo:  the extension panel open while you switch presets and drag faders
# The recordings are copied into work/ first; the originals are only ever read.
# usage: scripts/prepare.sh <flat.mov> <demo.mov>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ $# -eq 2 ] || { echo "usage: scripts/prepare.sh <flat recording> <demo recording>"; exit 1; }

# Geometry of the YouTube player and the extension panel in the recording, in source pixels.
# Measured on a 1280x720 OBS canvas with Zen at 100% zoom; re-measure for a different take
# (scripts/sheet.sh shows full frames) and update REVEAL in src/timeline.ts to match.
PLAYER_CROP="${PLAYER_CROP:-834:622:76:90}"

mkdir -p work/pcm public src/data
cp -p "$1" work/flat.mov
cp -p "$2" work/demo.mov

for n in flat demo; do
  echo "[$n] cropping the music video, extracting PCM"
  ffmpeg -v error -y -i "work/$n.mov" -vf "crop=$PLAYER_CROP" -c:v libx264 -crf 14 -preset fast -g 30 \
    -c:a aac -b:a 256k "public/${n}_mv.mp4"
  ffmpeg -v error -y -i "work/$n.mov" -vn -ac 1 -ar 22050 -f f32le "work/pcm/$n.f32"
  node tools/analyze.mjs "$n"
done
echo "[demo] full-frame copy for the reveal shot"
ffmpeg -v error -y -i work/demo.mov -an -c:v libx264 -crf 14 -preset fast -g 30 public/demo_screen.mp4

echo
echo "next: node tools/beats.mjs demo <from> <to>   (a drum-heavy window), then pick segment times in src/timeline.ts"
