#!/usr/bin/env bash
# Reproduce the exact files shipped in the AMO package from public sources.
#
#   ./scripts/build_model.sh
#
# Produces, under extension/models/:
#   htdemucs_6s_web.onnx   the converted, cut model (not shipped directly)
#   part0.bin .. part3.bin the four parts that ARE shipped
#
# Needs python3 with the onnx package (pip install onnx).
#
# Then package with scripts/package.sh (Chrome) or the commands in
# docs/source-submission.md (Firefox).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS="$ROOT/extension/models"
WORK="${WORK:-$ROOT/.build}"
MODEL_URL="https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx"

mkdir -p "$MODELS" "$WORK"

# 1. fetch the published fp16-weights export
if [ ! -f "$WORK/htdemucs_6s_fp16weights.onnx" ]; then
  echo "[1/4] downloading htdemucs_6s_fp16weights.onnx (~136 MB)"
  curl -L --fail --progress-bar -o "$WORK/htdemucs_6s_fp16weights.onnx" "$MODEL_URL"
fi

# 2. rewrite float64 -> float32.
#    The published export computes its inverse STFT in float64, and onnxruntime-web
#    ships no float64 kernels, so it fails with "Could not find an implementation for
#    ConstantOfShape(9)". 341 Constant nodes and 1 ConstantOfShape are affected.
echo "[2/4] converting float64 constants to float32"
python3 "$ROOT/engine/webgpu/make_web_model.py" \
  --src "$WORK/htdemucs_6s_fp16weights.onnx" \
  --dst "$WORK/htdemucs_6s_full_web.onnx"

# 3. cut the inverse STFT out of the graph; the worker does it in JS.
#    ~16k shape/scatter nodes that ran on the WASM fallback, and 41 MB of constants.
echo "[3/4] cutting the inverse STFT out of the graph"
python3 "$ROOT/engine/webgpu/cut_istft.py" \
  --src "$WORK/htdemucs_6s_full_web.onnx" \
  --dst "$MODELS/htdemucs_6s_web.onnx"

# 4. split into four equal parts.
#    AMO rejects any single archive entry over its per-file limit, so the model ships
#    as four ~22 MB files that the worker concatenates in memory
#    (see loadModelParts in extension/src/engine.worker.js).
echo "[4/4] splitting into 4 parts"
python3 - "$MODELS/htdemucs_6s_web.onnx" "$MODELS" <<'PY'
import os, sys
src, outdir = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
N = 4
size = (len(data) + N - 1) // N
for f in os.listdir(outdir):
    if f.startswith("part") and f.endswith(".bin"):
        os.remove(os.path.join(outdir, f))
for i in range(N):
    chunk = data[i*size:(i+1)*size]
    open(os.path.join(outdir, "part%d.bin" % i), "wb").write(chunk)
    print("  part%d.bin  %.1f MB" % (i, len(chunk)/1e6))
print("  total %.1f MB" % (len(data)/1e6))
PY

echo
echo "done. now package:"
echo "  Firefox: see docs/source-submission.md"
echo "  Chrome : VERSION=x.y.z ./scripts/package.sh"
