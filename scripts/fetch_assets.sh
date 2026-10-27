#!/usr/bin/env bash
# Fetch the two large assets the extension needs. Neither is in git.
#   extension/models/part0..3.bin   89 MB   converted, cut 6-stem model in four parts
#   extension/vendor/*              84 MB   onnxruntime-web runtime
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORT_VERSION="1.31.0-dev.20260918-bc8e7ed75"

mkdir -p "$ROOT/extension/models" "$ROOT/extension/vendor"

if [ ! -f "$ROOT/extension/models/part0.bin" ]; then
  echo "[1/2] model: download, convert, cut and split (scripts/build_model.sh)"
  "$ROOT/scripts/build_model.sh"
else
  echo "[1/2] model already present"
fi

if [ ! -f "$ROOT/extension/vendor/ort.webgpu.mjs" ]; then
  echo "[2/2] onnxruntime-web: downloading $ORT_VERSION"
  TMP="$(mktemp -d)"
  ( cd "$TMP" && npm pack "onnxruntime-web@$ORT_VERSION" >/dev/null 2>&1 )
  tar xzf "$TMP"/onnxruntime-web-*.tgz -C "$TMP"
  cp "$TMP"/package/dist/ort.webgpu.mjs      "$ROOT/extension/vendor/"
  cp "$TMP"/package/dist/ort.webgpu.min.js   "$ROOT/extension/vendor/"
  cp "$TMP"/package/dist/ort-wasm-simd-threaded.mjs "$ROOT/extension/vendor/" 2>/dev/null || true
  cp "$TMP"/package/dist/*.wasm              "$ROOT/extension/vendor/" 2>/dev/null || true
  rm -rf "$TMP"
  echo "[2/2] wrote extension/vendor/"
else
  echo "[2/2] onnxruntime-web already present"
fi

echo
echo "done. load the extension:"
echo "  chrome://extensions -> Developer mode -> Load unpacked -> select $ROOT/extension"
echo "then open any YouTube video and click the pill in the bottom right."