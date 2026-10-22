#!/usr/bin/env bash
# Build the store package and the unpacked dev folder.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
EXT="$ROOT/extension"

for need in manifest.json src/host.html src/content.js src/engine.worker.js \
            vendor/ort.webgpu.mjs models/part0.bin icons/icon128.png; do
  [ -e "$EXT/$need" ] || { echo "missing: $need"; echo "run scripts/fetch_assets.sh first"; exit 1; }
done

rm -rf "$DIST"; mkdir -p "$DIST"

# what actually ships, nothing else
STAGE="$DIST/chrome"
mkdir -p "$STAGE"
cp "$EXT/manifest.json" "$STAGE/"
cp -r "$EXT/src" "$STAGE/"
cp -r "$EXT/icons" "$STAGE/"
cp -r "$EXT/vendor" "$STAGE/"
mkdir -p "$STAGE/models"
cp "$EXT"/models/part*.bin "$STAGE/models/"
cp "$EXT/README.md" "$STAGE/" 2>/dev/null || true

( cd "$DIST" && zip -qr "instrument-focus-chrome-${VERSION:-dev}.zip" chrome )
echo "package: $DIST/instrument-focus-chrome-${VERSION:-dev}.zip"
du -h "$DIST/instrument-focus-chrome-${VERSION:-dev}.zip" | awk '{print "size:", $1}'
