#!/usr/bin/env bash
# Contact sheets for choosing segment times: one frame per second of the fader block, and
# one full frame every 2 s. Read the fader states off the sheet to fill in src/timeline.ts.
# usage: scripts/sheet.sh [work/demo.mov] [crop of the fader block, default 320:128:912:540]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC="${1:-work/demo.mov}"; CROP="${2:-320:128:912:540}"
mkdir -p out/sheets
ffmpeg -v error -y -i "$SRC" -vf "fps=1,crop=$CROP,tile=4x9:padding=6:color=red" out/sheets/faders_%d.png
ffmpeg -v error -y -i "$SRC" -vf "fps=1/2,scale=480:-1,tile=4x3:padding=4" out/sheets/frames_%d.png
echo "wrote out/sheets/ (fader sheets: row-major, 1 s per tile, 36 s per sheet)"
