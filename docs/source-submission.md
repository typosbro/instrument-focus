# Source code submission — Stems for YouTube

## Answer to AMO's question: YES

The add-on uses processing that generates files included in the package. Specifically:

1. **A minified third-party library is bundled.** `vendor/ort.webgpu.min.js` is ONNX Runtime
   Web's minified distribution, taken unmodified from npm.
2. **The model is generated.** The shipped ONNX file is transformed from a published
   upstream export by `engine/webgpu/make_web_model.py` (precision) and
   `engine/webgpu/cut_istft.py` (removes the final inverse-STFT subgraph, which the
   add-on computes in plain JS instead), then split into four parts.
3. **The model is split.** `scripts/build_model.sh` cuts the 89 MB model into
   `part0.bin` .. `part3.bin` so no single archive entry exceeds AMO's per-file limit.

The add-on's own code — `src/content.js`, `src/host.js`, `src/engine.worker.js`,
`src/host.html`, `src/ui.css` — is hand-written and shipped exactly as authored. It is not
minified, bundled or transpiled.

## Full source

https://github.com/typosbro/instrument-focus

## Step-by-step build

From a clean checkout:

    git clone https://github.com/typosbro/instrument-focus
    cd instrument-focus

    # 1. Python with the onnx package, used by the model build
    pip install onnx

    # 2. Build the model (download, convert, cut, split) and fetch the runtime
    ./scripts/fetch_assets.sh

    # 3. Package for Firefox
    ./scripts/package_firefox.sh

## What each step does

**Step 2** downloads `htdemucs_6s_fp16weights.onnx` (136 MB) from
https://huggingface.co/StemSplitio/htdemucs-6s-onnx (MIT) and onnxruntime-web from npm,
then runs `scripts/build_model.sh`, which does three things to the model:

- *Convert.* The published export computes its inverse STFT in float64. onnxruntime-web
  ships no float64 kernels, so the model fails to load with
  "Could not find an implementation for ConstantOfShape(9)". The script rewrites 341
  `Constant` nodes and 1 `ConstantOfShape` node from double to float32. This is the only
  modification made to the upstream weights; no values are altered beyond the precision
  change.
- *Cut.* The graph's last stage, an inverse STFT written as about 16,000 Slice/ScatterND
  nodes, is removed. The model now outputs the two tensors that stage combined
  (`spec`, `wave`), and `src/engine.worker.js` (`makeIstft`) does the same maths in JS.
  No weight changes; both outputs are bit-identical to the full graph's intermediates.
- *Split.* The 89 MB model becomes four 22.3 MB files.

**Step 3** zips the extension with `manifest.json` at the archive root.

## Verification

The build is deterministic and byte-reproducible. Confirmed on the submitted package:

    two clean runs of the cut step, sha256 of extension/models/htdemucs_6s_web.onnx:
    2a15e9f47d4c1c37eb785df24aa7a8e6bfd088a53faed604ee9404cd8002f6d3   89,234,975 bytes
    2a15e9f47d4c1c37eb785df24aa7a8e6bfd088a53faed604ee9404cd8002f6d3

    (re-check the hash against the submitted package before each upload)

So the shipped `part0.bin` .. `part3.bin` are a direct, reproducible split of the model that
step 2 produces. The worker concatenates them in memory at runtime
(`loadModelParts` in `src/engine.worker.js`).

## What is third-party and unmodified

| file | origin | licence |
|---|---|---|
| vendor/ort.webgpu.mjs, ort.webgpu.min.js, ort-wasm-*.{mjs,wasm} | onnxruntime-web, npm | MIT |
| models/part0..3.bin | StemSplitio/htdemucs-6s-onnx, converted | MIT |

Neither is modified except for the float64-to-float32 rewrite and the inverse-STFT cut
described above.

## Notes for the reviewer

- No code is fetched at runtime. Everything is bundled.
- The CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- The linter's "Function constructor is eval" warnings come from ONNX Runtime Web's WASM
  glue in `vendor/`, not from add-on code.
