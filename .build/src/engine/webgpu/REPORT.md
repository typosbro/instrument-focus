# demucs in the browser — measurement spike (2026-10-20)

**One line:** RTF = **0.191** measured on **Chrome 154 + onnxruntime-web 1.30, WebGPU EP (NVIDIA RTX 4060 Laptop, Vulkan)** —
30.0 s of real audio in 5,734 ms — so real-time browser separation is **FEASIBLE on throughput** (5.2x realtime),
but the model's static 7.8 s segment means **7.8 s of algorithmic latency**, and six-stem piano+guitar is
**AVAILABLE** as a published ONNX export.

> Backend honesty: this box is Linux/x86_64 with an RTX 4060, **not Apple Silicon**. The M1 Pro number below is
> marked [estimate]. WebGPU works here only in **headful Chrome under Xvfb** — headless Chrome reports WebGPU as
> software-unavailable (details below).

---

## A. Throughput

### Model

| field | value |
|---|---|
| file | `htdemucs_6s.onnx` |
| URL | https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx |
| repo sha | `49df9b6989cf2150840ea65b0bef77a2e471b678` (lastModified 2026-05-21) |
| bytes | 258,159,781 |
| sha256 | `48f8e84945579f8ab340e083339e9221e03785dbe733a52c388200b6d3ca779a` |
| variant | htdemucs_6s, 6 stems, opset 17, IR 8, producer pytorch 2.4.1 |
| graph | 24,671 nodes (11,654 of them `Constant`; weights are baked in as Constant nodes, hence 258 MB for ~27 M params) |
| input | `mix` float32 [1, 2, 343980] — stereo, 44.1 kHz, **7.8 s fixed segment** |
| output | `stems` float32 [1, 6, 2, 343980], float32, 16.5 MB — order drums, bass, other, vocals, guitar, piano |

### Measurement

Audio: `the project tree`, first 30.0 s, stereo 44.1 kHz.
(That folder is lopsided: piano RMS 0.2455, drums 0.0741, the other four stems ~1e-4 — effectively silent.
The piano stem is used because it is real signal at a normal level.)
30 s = 1,323,000 samples = 4 segments of 343,980; the last segment is zero-padded by 52,920 samples.

| metric | run 1 | run 2 | run 3 |
|---|---|---|---|
| session create | 4,898 ms | 3,535 ms | 3,434 ms |
| first run (cold, shader build) | 1,682 ms | 1,470 ms | — |
| chunk 1 | 1,428.8 ms | 1,432.3 ms | 1,418.1 ms |
| chunk 2 | 1,434.0 ms | 1,430.9 ms | 1,420.5 ms |
| chunk 3 | 1,427.9 ms | 1,430.9 ms | 1,417.3 ms |
| chunk 4 | 1,433.0 ms | 1,431.7 ms | 1,418.7 ms |
| **total wall** | **5,734.4 ms** | 5,733.2 ms | 5,682.1 ms |
| **RTF (wall / audio)** | **0.191** | 0.191 | 0.189 |
| RTF per 7.8 s segment | 0.183 | 0.183 | 0.182 |
| speed | 5.23x realtime | 5.23x | 5.29x |
| JS heap peak (page) | 71.0 MB | 70.6 MB | 70.5 MB |

- Backend: **WebGPU execution provider**, adapter `nvidia / lovelace`, Chrome 154.0.8037.57, Linux 7.0.0-38 x86_64.
- ONNX Runtime Web 1.30.0 loaded from `page/vendor/` (no CDN at runtime), model from local http server.
- Peak memory: **5,367.8 MB RSS** for the whole spike Chrome process tree (13 processes, sampled at 0.5 s over the
  run, isolated from other Chrome instances by profile path). Page JS heap is only 70 MB — the rest is the
  252 MB model, ORT's graph copies, wasm heap and GPU driver allocations.
- Correctness check, not just shapes: with piano-only input the piano stem comes back RMS 0.2446 / absmax 0.857
  (input RMS 0.2455) and the other five stems are ≤0.0039 absmax. Matches the native ORT reference on the same
  segment. The tensor is real audio, not zeros.

### The stock export does NOT load in the browser (important)

`htdemucs_6s.onnx` as published fails `InferenceSession.create` on both EP's:

```
webgpu: TransformerMemcpyImpl::IsNodeCompatibleWithProvider: Provider type for ConstantOfShape node
        '/real_istft/ConstantOfShape' is not set.
wasm:   Could not find an implementation for ConstantOfShape(9) node '/real_istft/ConstantOfShape'
```

Root cause: the export computes its iSTFT reconstruction in **float64** — 3,404 nodes, 341 double constants,
one `ConstantOfShape` with a DOUBLE value. onnxruntime-web is built with a **reduced type list: no float64 kernels**.
Native onnxruntime 1.31 has them, which is why the author's Python benchmark works and the HF card looks fine.

Fix used here (`make_web_model.py`): global double→float32 rewrite (Cast targets, Constant tensors,
ConstantOfShape value). Parity against the original on native ORT: **max abs diff 5.96e-08** on a 7.8 s segment.
Result: `models/htdemucs_6s_web.onnx` (252,589,213 bytes). Anyone shipping this needs that conversion step.

For reference, a 4-stem browser-targeted export also exists and loads *unmodified*:
https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx (180,534,758 bytes) — but it wants
the STFT computed outside the model (inputs `input` [1,2,343980] + `x` [1,4,2048,336]), i.e. more JS DSP glue.

### WebGPU on this box (why flags matter)

| config | WebGPU status |
|---|---|
| headless (`--headless=new`), every flag combo tried | `webgpu: unavailable_software`; `navigator.gpu` undefined, `requestAdapter()` null |
| headful under `xvfb-run`, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=native --ignore-gpu-blocklist --no-sandbox` | `webgpu: enabled`, adapter = NVIDIA lovelace, runs |
| headful without a display | cannot start |

Headless Chrome fell back to SwiftShader (CDP `SystemInfo`: `webgpu: unavailable_software`, `vulkan: disabled_off`),
so a headless-only spike would have wrongly concluded "WebGPU impossible" on a machine where it works.
Chrome profiles live under `a cache dir` (never /tmp), one Chrome at a time.

### WASM fallback

Session creation **succeeds** (3,411–3,548 ms) but the first `run()` throws `std::bad_alloc` — the 252 MB fp32
model plus ORT's optimized graph copy does not fit the wasm32 4 GB heap. Tried with
`enableMemPattern:false, enableCpuMemArena:false, graphOptimizationLevel:"extended"` — same result.
Next step for a WASM number: the published **136 MB fp16-weight variant** (`htdemucs_6s_fp16weights.onnx`).
Native onnxruntime CPU on this 20-core box, same segment: 1,645–2,372 ms (RTF 0.21–0.30).

### Apple Silicon [estimate]

An M1 Pro (16-core GPU, ~5.2 TFLOPS) against this RTX 4060 Laptop (~11–15 TFLOPS) suggests **1.5–2.5x slower**,
i.e. roughly **2.1–3.6 s per 7.8 s segment, RTF 0.27–0.46** — still faster than realtime. Treat as [estimate]:
ORT's WebGPU kernels and Metal behave differently, and this graph is 24k mostly-small ops. Re-run
`page/index.html` on the M1 Pro to replace the estimate with a measurement.

---

## B. Model availability: htdemucs_6s ONNX exists → AVAILABLE

Published, MIT-licensed, with a numpy reference implementation:

- https://huggingface.co/StemSplitio/htdemucs-6s-onnx — `htdemucs_6s.onnx` (258,159,781 B fp32),
  `htdemucs_6s_fp16weights.onnx` (136,428,532 B), `infer.py`.
- Identical mirror: https://huggingface.co/alekshandru/htdemucs-6s-onnx
- Author's claim: parity vs PyTorch fp32 at 2.42e-4 max abs diff (not re-verified against PyTorch here).

So piano + guitar in a browser build is a download plus the float64→float32 conversion, not an export project.
The 4-stem-only prior art (sevagh/demucs.onnx, timcsy/demucs-web) simply predates this export.

---

## Latency: what a real-time extension would actually need

The ONNX has a **static input of 343,980 samples = 7.8 s**. You cannot feed it 20 ms.

| quantity | value |
|---|---|
| segment the model needs | 7.8 s (343,980 samples @ 44.1 kHz stereo) |
| demucs' standard overlap | 0.25 → hop 5.85 s |
| compute per segment (measured) | 1.43 s |
| algorithmic latency floor | **7.8 s** (the network is non-causal; it must see the whole window) |
| GPU busy fraction at steady state | 1.43 / 5.85 = 24% |
| headroom for continuous streaming | 5.85 / 1.43 = 4.1x |

Throughput is fine: RTF 0.19 is far below the ~0.75 needed to keep overlap-add continuous. The blocker is the
**7.8 s lookahead**, which rules out live monitoring, mic-in effects, and DJ-style mixing on the dry signal.
It does not rule out "press play, stems appear ~8 s later and then keep up", nor offline/pre-rendered stems.

---

## Reproduce

```bash
cd the project tree
python3 -m http.server 8765 --bind 127.0.0.1 --directory page    # page + model + audio
xvfb-run -a python3 run_page.py webgpu 8765 results/webgpu.json headful
```

Files:
- `page/index.html`, `page/app.js` — measurement harness (adapter probe, decode, 4 segments, timing, per-stem stats)
- `page/vendor/` — onnxruntime-web 1.30 (local, no CDN), `page/audio30.wav`
- `run_page.py` — Playwright driver (headful under Xvfb; records GPU feature status via CDP)
- `make_web_model.py` — float64→float32 rewrite that makes the export load in the browser
- `gpu_diag.py`, `cdp_info.py`, `probe.py`, `probe2.py` — WebGPU flag diagnostics
- `results/*.json` — raw measurements (webgpu_6s_piano.json, webgpu_final.json, webgpu_mem.json, wasm_6s.json, …)
