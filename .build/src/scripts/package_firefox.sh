#!/usr/bin/env bash
# Package the Firefox build. manifest.json must sit at the archive root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-0.1.4}"
STAGE="${STAGE:-$ROOT/.build/ff}"
OUT="$ROOT/dist/stems-for-youtube-firefox-$VERSION.xpi"

rm -rf "$STAGE"; mkdir -p "$STAGE/models"
cp "$ROOT/extension/manifest.firefox.json" "$STAGE/manifest.json"
cp -r "$ROOT/extension/src" "$ROOT/extension/icons" "$ROOT/extension/vendor" "$STAGE/"
cp "$ROOT"/extension/models/part*.bin "$STAGE/models/"

( cd "$STAGE" && zip -qr "$OUT" . -x '.*' )
echo "wrote $OUT"
ls -la "$OUT" | awk '{printf "  %.1f MB\n", $5/1e6}'
