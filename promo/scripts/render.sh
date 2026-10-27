#!/usr/bin/env bash
# Render the reel in each language, then master the audio to Instagram loudness (-14 LUFS).
# usage: scripts/render.sh [en] [uz]   (default: both)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f src/data/tempo.json ] || { echo "run scripts/prepare.sh and tools/beats.mjs first"; exit 1; }
mkdir -p out
for L in "${@:-en uz}"; do
  for lang in $L; do
    echo "[$lang] rendering"
    npx remotion render src/index.ts Reel "out/raw_$lang.mp4" --props="{\"lang\":\"$lang\"}" \
      --codec=h264 --crf=16 --log=error
    ffmpeg -v error -y -i "out/raw_$lang.mp4" -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 \
      -c:a aac -b:a 192k -ar 48000 -movflags +faststart "out/reel_$lang.mp4"
    rm "out/raw_$lang.mp4"
    echo "[$lang] wrote out/reel_$lang.mp4"
  done
done
