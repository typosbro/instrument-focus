// Measurement spike: htdemucs_6s ONNX in browser via onnxruntime-web (WebGPU or WASM).
const logEl = document.getElementById("log");
const lines = [];
function log(...a) {
  const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
  lines.push(s); logEl.textContent = lines.join("\n"); console.log("[spike]", s);
}

const params0 = new URLSearchParams(location.search);
const MODEL = "/models/" + (params0.get("model") || "htdemucs_6s_web.onnx") + "";
const SEG = 343980;          // model-fixed segment: 7.8 s @ 44.1 kHz stereo
const SR = 44100;
const AUDIO_SECONDS = 30;

async function getAdapterInfo() {
  if (!navigator.gpu) return { ok: false, reason: "navigator.gpu undefined" };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a) return { ok: false, reason: "requestAdapter() returned null" };
    let info = {};
    try { info = a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : {}; } catch (e) {}
    const feats = [...a.features];
    const lim = { maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize };
    return { ok: true, info, feats, lim };
  } catch (e) { return { ok: false, reason: String(e) }; }
}

async function loadAudio() {
  const res = await fetch("/audio30.wav?v=" + Date.now(), { cache: "no-store" });
  const buf = await res.arrayBuffer();
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, SR * AUDIO_SECONDS, SR);
  const ab = await ctx.decodeAudioData(buf);
  const L = ab.getChannelData(0), R = ab.getChannelData(1);
  return { L, R, n: ab.length };
}

function makeInput(L, R, offset) {
  const out = new Float32Array(2 * SEG);
  for (let i = 0; i < SEG; i++) {
    const j = offset + i;
    out[i] = j < L.length ? L[j] : 0;
    out[SEG + i] = j < R.length ? R[j] : 0;
  }
  return new ort.Tensor("float32", out, [1, 2, SEG]);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const forced = params.get("ep");
  const result = { t0: new Date().toISOString(), ua: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated };

  log("UA:", navigator.userAgent);
  log("crossOriginIsolated:", String(self.crossOriginIsolated), " hardwareConcurrency:", navigator.hardwareConcurrency);
  result.adapter = await getAdapterInfo();
  log("webgpu adapter:", JSON.stringify(result.adapter));

  try {
    const audio = await loadAudio();
    result.audio = { samples: audio.n, seconds: audio.n / SR, sr: SR };
    log("audio decoded:", audio.n, "samples =", (audio.n / SR).toFixed(2), "s");
    result.audioChecksum = (() => { let s = 0; for (let i = 0; i < audio.n; i += 997) s += Math.abs(audio.L[i]); return +s.toFixed(4); })();

    ort.env.wasm.wasmPaths = "/vendor/";
    ort.env.logLevel = "error";
    const threadsParam = params.get("threads");
    if (threadsParam) ort.env.wasm.numThreads = parseInt(threadsParam, 10);
    result.wasmNumThreadsEnv = ort.env.wasm.numThreads;

    const epOrder = forced ? [forced] : ["webgpu", "wasm"];
    let session = null, usedEP = null, createMs = 0, epErrors = [];
    for (const ep of epOrder) {
      const t = performance.now();
      try {
        // NOTE: webgpu must be paired with wasm so int64/shape ops have a CPU fallback;
        // a webgpu-only session fails in TransformerMemcpyImpl on /real_istft/ConstantOfShape.
        session = await ort.InferenceSession.create(MODEL, {
          executionProviders: ep === "webgpu" ? ["webgpu", "wasm"] : [ep],
          graphOptimizationLevel: "all",
          // keep threads explicit so the WASM number is reproducible
          ...(ep === "wasm" ? { intraOpNumThreads: threadsParam ? parseInt(threadsParam, 10) : 1, enableMemPattern: false, enableCpuMemArena: false, graphOptimizationLevel: "extended" } : {}),
        });
        usedEP = ep; createMs = performance.now() - t;
        break;
      } catch (e) {
        epErrors.push({ ep, error: String(e && e.message || e).slice(0, 400) });
        log("EP FAILED:", ep, String(e && e.message || e).slice(0, 300));
      }
    }
    result.epErrors = epErrors;
    if (!session) { result.fatal = "no execution provider worked"; log("FATAL", result.fatal); window.__RESULT = result; return; }

    result.usedEP = usedEP;
    result.createMs = +createMs.toFixed(1);
    result.ortVersion = ort.env.versions ? ort.env.versions.web : "unknown";
    result.wasmThreads = ort.env.wasm.numThreads;
    log("session OK on", usedEP, "create", createMs.toFixed(0), "ms", "ort", result.ortVersion, "wasmThreads", String(ort.env.wasm.numThreads));

    const inName = session.inputNames[0], outName = session.outputNames[0];
    result.inputs = session.inputNames; result.outputs = session.outputNames;
    log("inputs", JSON.stringify(session.inputNames), "outputs", JSON.stringify(session.outputNames));

    // --- single chunk: shape + first-run (cold, includes shader/plan build) ---
    const t1 = makeInput(audio.L, audio.R, 0);
    let t = performance.now();
    let y = await session.run({ [inName]: t1 });
    const firstMs = performance.now() - t;
    const out = y[outName];
    result.single = { firstRunMs: +firstMs.toFixed(1), shape: out.dims, dtype: out.type, bytes: out.data.length * 4 };
    // per-stem energy proves this is a real inference, not an empty tensor
    const stemStats = [];
    for (let s = 0; s < out.dims[1]; s++) {
      let sum = 0, mx = 0;
      const base = s * 2 * SEG;
      for (let i = 0; i < SEG * 2; i += 17) { const v = out.data[base + i]; sum += v * v; if (Math.abs(v) > mx) mx = Math.abs(v); }
      stemStats.push({ rms: +Math.sqrt(sum / (SEG * 2 / 17)).toFixed(5), absmax: +mx.toFixed(5) });
    }
    result.stemStats = stemStats;
    log("first run", firstMs.toFixed(0), "ms  shape", JSON.stringify(out.dims), "dtype", out.type);
    log("stem stats", JSON.stringify(stemStats));

    // --- warmup 1 more, then timed 30 s ---
    await session.run({ [inName]: t1 });

    const nChunks = Math.ceil(audio.n / SEG);
    const times = [];
    const memBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    let peakJs = memBefore || 0;
    const tAll = performance.now();
    for (let c = 0; c < nChunks; c++) {
      const inp = makeInput(audio.L, audio.R, c * SEG);
      const s0 = performance.now();
      await session.run({ [inName]: inp });
      times.push(+(performance.now() - s0).toFixed(1));
      if (performance.memory) peakJs = Math.max(peakJs, performance.memory.usedJSHeapSize);
      log("chunk", c, times[times.length - 1], "ms");
    }
    const totalMs = performance.now() - tAll;
    const audioProcessed = audio.n / SR;
    result.run = {
      chunks: nChunks, chunkMs: times, totalMs: +totalMs.toFixed(1),
      audioSeconds: +audioProcessed.toFixed(3),
      rtf: +(totalMs / 1000 / audioProcessed).toFixed(3),
      rtfPerSegment: +(Math.min(...times) / 1000 / 7.8).toFixed(3),
      segPerSec: +(1000 / (totalMs / nChunks)).toFixed(2),
      jsHeapPeakMB: peakJs ? +(peakJs / 1048576).toFixed(1) : null,
    };
    log("TOTAL", totalMs.toFixed(0), "ms for", audioProcessed.toFixed(1), "s audio -> RTF", result.run.rtf);
    result.ok = true;
    window.__RESULT = result;
    log("done");
  } catch (e) {
    result.fatal = String(e && e.stack || e);
    log("ERROR", String(e && e.stack || e));
    window.__RESULT = result;
  }
}

window.__RESULT = null;
main();
