#!/usr/bin/env bash
# Fetch the two large assets the extension needs. Neither is in git.
#   extension/models/htdemucs_6s_web.onnx   241 MiB  converted 6-stem model
#   extension/vendor/*                      84 MiB   onnxruntime-web runtime
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORT_VERSION="1.31.0-dev.20260918-bc8e7ed75"
MODEL_URL="https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx"

mkdir -p "$ROOT/extension/models" "$ROOT/extension/vendor"

if [ ! -f "$ROOT/extension/models/htdemucs_6s_web.onnx" ]; then
  echo "[1/2] model: downloading about 258 MB from Hugging Face"
  curl -L --fail --progress-bar -o "$ROOT/extension/models/htdemucs_6s.onnx" "$MODEL_URL"
  echo "[1/2] converting float64 -> float32 (ORT Web ships no float64 kernels)"
  ( cd "$ROOT/extension" && python3 "$ROOT/engine/webgpu/make_web_model.py" )
  rm -f "$ROOT/extension/models/htdemucs_6s.onnx"
  echo "[1/2] wrote extension/models/htdemucs_6s_web.onnx"
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