/* Stems for YouTube — separation worker.
 * Runs htdemucs_6s (converted float64->float32 export) on WebGPU in a dedicated
 * worker owned by the extension-origin host frame, so the page CSP cannot block
 * it. The model is non-causal and always consumes a fixed 7.8 s window; this
 * worker overlaps windows by 25% (same window/weighting as the published
 * infer.py) and writes the six stems to extension-origin IndexedDB one stride
 * (5.85 s) at a time, nearest the playhead first, so playback can start after
 * the first window and no context ever holds the whole separated song.
 */
"use strict";

const SR = 44100;
const SEG = 343980;            // 7.8 s @ 44.1 kHz, fixed by the model
const OVERLAP = SEG >> 2;      // 85,995
const STRIDE = SEG - OVERLAP;  // 257,985
const STEMS = 6;
const STORE_SCALE = 4;         // int16 headroom: values up to +/-4.0
const I16 = 32767 / STORE_SCALE;
const DB_NAME = "stems-yt-cache";
const DB_VER = 1;

let ort = null;
let session = null;
let enginePromise = null;
let engineInfo = null;
let cancelled = false;
let deviceLost = null;
const RUN_TIMEOUT_MS = 60000;  // one window is ~1-3 s; anything near this is a stalled GPU

function runModel(feeds) {
  if (deviceLost) return Promise.reject(new Error(deviceLost));
  let timer;
  const stall = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error(deviceLost || "model run stalled for " + RUN_TIMEOUT_MS / 1000 + " s (GPU busy or lost)"));
    }, RUN_TIMEOUT_MS);
  });
  return Promise.race([session.run(feeds), stall]).finally(function () { clearTimeout(timer); });
}

const post = (m, transfer) => self.postMessage(m, transfer || []);

/* --------------------------------------------------------------- IndexedDB */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "videoId" });
      if (!db.objectStoreNames.contains("stems")) db.createObjectStore("stems", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("idb aborted"));
  });
}

async function deleteSongData(db, videoId) {
  const tx = db.transaction(["songs", "stems"], "readwrite");
  tx.objectStore("songs").delete(videoId);
  tx.objectStore("stems").delete(IDBKeyRange.bound(videoId + ":", videoId + ":\uffff"));
  await txDone(tx);
}

function putChunkSet(db, videoId, chunkIndex, bufs, frames) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stems", "readwrite");
    const store = tx.objectStore("stems");
    for (let s = 0; s < STEMS; s++) {
      store.put({
        key: videoId + ":" + s + ":" + chunkIndex,
        videoId: videoId,
        stem: s,
        chunk: chunkIndex,
        frames: frames,
        scale: STORE_SCALE,
        data: bufs[s].buffer.slice(0, frames * 2 * 2),
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("idb chunk aborted"));
  });
}

function putSongMeta(db, meta) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("songs", "readwrite");
    tx.objectStore("songs").put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("idb meta aborted"));
  });
}

/* ------------------------------------------------------------------ engine */
/* The published add-on cannot carry the 131 MB model as one archive entry: AMO rejects it with
   "File exceeding size limit in archive". Ship it as fixed-size parts and stitch them back
   together in memory. ORT accepts the bytes directly, so nothing else changes. */
var MODEL_PARTS = 4;
async function loadModelParts(modelUrl) {
  var base = modelUrl.replace(/[^/]*$/, "");
  var bufs = await Promise.all(Array.from({ length: MODEL_PARTS }, function (_, i) {
    return fetch(base + "part" + i + ".bin").then(function (r) {
      if (!r.ok) throw new Error("model part " + i + ": HTTP " + r.status);
      return r.arrayBuffer();
    });
  }));
  var total = 0;
  for (var i = 0; i < bufs.length; i++) total += bufs[i].byteLength;
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < bufs.length; j++) { out.set(new Uint8Array(bufs[j]), off); off += bufs[j].byteLength; }
  return out;
}

async function ensureEngine(vendorUrl, modelUrl) {
  // engineInfo is set only after the warm-up run: returning on `session` alone let a
  // separate() race the warm-up, and ORT-web hangs on concurrent runs of one session.
  if (engineInfo) return engineInfo;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const t0 = performance.now();
    if (!navigator.gpu) throw new Error("navigator.gpu is undefined in the separation worker");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    if (adapter.isFallbackAdapter) throw new Error("only a software (fallback) WebGPU adapter is available; refusing to run");
    const info = {};
    try {
      if (adapter.info) {
        info.vendor = adapter.info.vendor; info.architecture = adapter.info.architecture;
        info.device = adapter.info.device; info.description = adapter.info.description;
      }
    } catch (e) {}
    post({ type: "engine-status", msg: "loading onnxruntime-web", adapter: info });
    ort = await import(vendorUrl + "ort.webgpu.mjs");
    ort.env.wasm.wasmPaths = vendorUrl;
    ort.env.wasm.numThreads = 1;   // youtube.com is not crossOriginIsolated
    ort.env.logLevel = "error";
    const tCreate = performance.now();
    var modelBytes = await loadModelParts(modelUrl);
    session = await ort.InferenceSession.create(modelBytes, {
      // wasm stays paired for any shape op ORT-web has no WebGPU kernel for.
      // The inverse STFT, which needed it most, now runs in JS (istftInto).
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });
    const createMs = performance.now() - tCreate;
    modelBytes = null;
    if (session.outputNames.indexOf("spec") < 0 || session.outputNames.indexOf("wave") < 0) {
      throw new Error("model outputs " + session.outputNames.join(",") + "; expected spec,wave (run scripts/build_model.sh)");
    }
    post({ type: "engine-status", msg: "session created in " + Math.round(createMs) + " ms", createMs: createMs });
    // A lost device leaves session.run() pending forever; say so instead of hanging.
    Promise.resolve(ort.env.webgpu && ort.env.webgpu.device).then(function (dev) {
      if (dev && dev.lost) dev.lost.then(function (info) {
        deviceLost = "WebGPU device lost" + (info && info.message ? ": " + info.message : "");
        post({ type: "error", stage: "gpu", message: deviceLost });
      });
    }).catch(function () {});
    const zeros = new Float32Array(2 * SEG);
    const tWarm = performance.now();
    await session.run({ mix: new ort.Tensor("float32", zeros, [1, 2, SEG]) });
    const warmMs = performance.now() - tWarm;
    engineInfo = {
      adapter: info,
      ortVersion: (ort.env.versions && ort.env.versions.web) || "unknown",
      createMs: createMs,
      warmMs: warmMs,
      totalMs: performance.now() - t0,
    };
    post({ type: "engine-ready", info: engineInfo });
    return engineInfo;
  })();
  try {
    return await enginePromise;
  } catch (e) {
    enginePromise = null;
    throw e;
  }
}

/* ---------------------------------------------------------- inverse STFT */
/* The model graph stops at the padded spectrogram ("spec", [1,6,2,2,2049,340])
   and the time branch ("wave", [1,6,2,SEG]). The stock export ran its inverse
   STFT as ~16k Slice/ScatterND nodes, most of them on the WASM fallback, which
   bounced every window between GPU and CPU. Here it is a plain real IFFT with
   overlap-add, the same maths as HTDemucs _ispec: hann window, n_fft 4096,
   hop 1024, normalized, centered, then cropped by 1536 samples. */
const N_FFT = 4096, HOP = 1024, BINS = N_FFT / 2 + 1, HALF = N_FFT / 2;
const SPEC_FRAMES = 340;
const ISTFT_OFFSET = N_FFT / 2 + 1536;  // center trim + HTDemucs pad

function makeIstft() {
  const M = HALF;                        // real IFFT of N via complex FFT of N/2
  const bits = Math.log2(M);
  const rev = new Uint32Array(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  // Contiguous twiddles per butterfly stage (sizes 8..M); sizes 2 and 4 are unrolled below.
  const twRe = [], twIm = [];
  for (let size = 8; size <= M; size <<= 1) {
    const h = size >> 1, r = new Float64Array(h), i = new Float64Array(h);
    for (let j = 0; j < h; j++) { r[j] = Math.cos(2 * Math.PI * j / size); i[j] = Math.sin(2 * Math.PI * j / size); }
    twRe.push(r); twIm.push(i);
  }
  const postRe = new Float64Array(M), postIm = new Float64Array(M);
  for (let k = 0; k < M; k++) { postRe[k] = Math.cos(2 * Math.PI * k / N_FFT); postIm[k] = Math.sin(2 * Math.PI * k / N_FFT); }
  // sqrt(n_fft) undoes the normalized forward STFT; 1/M is the IFFT scale.
  const win = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) win[n] = (0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT)) * Math.sqrt(N_FFT) / M;
  const outLen = N_FFT + HOP * (SPEC_FRAMES - 1);
  const env = new Float64Array(outLen);
  for (let t = 0; t < SPEC_FRAMES; t++) for (let n = 0; n < N_FFT; n++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT);
    env[t * HOP + n] += w * w;
  }
  const invEnv = new Float32Array(SEG);
  for (let j = 0; j < SEG; j++) { const e = env[ISTFT_OFFSET + j]; invEnv[j] = e > 1e-11 ? 1 / e : 1; }
  const re = new Float64Array(M), im = new Float64Array(M);
  const y = new Float64Array(outLen);

  // spec: Float32Array of [6,2,2,BINS,SPEC_FRAMES]. Adds the inverse of signal
  // `sig` (= stem * 2 + channel) into out[outOff .. outOff + SEG).
  return function istftInto(spec, sig, out, outOff) {
    const reBase = (sig * 2) * BINS * SPEC_FRAMES;
    const imBase = reBase + BINS * SPEC_FRAMES;
    y.fill(0);
    for (let t = 0; t < SPEC_FRAMES; t++) {
      // Z[k] = (X[k] + conj X[M-k]) + i e^{+2pi i k/N} (X[k] - conj X[M-k]); DC/Nyquist imag dropped as irfft does.
      for (let k = 0; k < M; k++) {
        const xr = spec[reBase + k * SPEC_FRAMES + t];
        const xi = k === 0 ? 0 : spec[imBase + k * SPEC_FRAMES + t];
        const yr = spec[reBase + (M - k) * SPEC_FRAMES + t];
        const yi = k === 0 ? 0 : -spec[imBase + (M - k) * SPEC_FRAMES + t];
        const ar = xr + yr, ai = xi + yi;
        const dr = xr - yr, di = xi - yi;
        const pr = postRe[k], pi = postIm[k];
        const br = dr * pr - di * pi, bi = dr * pi + di * pr;
        const j = rev[k];
        re[j] = 0.5 * (ar - bi);
        im[j] = 0.5 * (ai + br);
      }
      // Inverse FFT (twiddles e^{+i...}), stages 2 and 4 as one radix-4 pass.
      for (let i = 0; i < M; i += 4) {
        const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
        const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
        const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
        const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
        re[i] = ar + cr; im[i] = ai + ci; re[i + 2] = ar - cr; im[i + 2] = ai - ci;
        re[i + 1] = br - di; im[i + 1] = bi + dr; re[i + 3] = br + di; im[i + 3] = bi - dr;
      }
      for (let size = 8, st = 0; size <= M; size <<= 1, st++) {
        const h = size >> 1, wr = twRe[st], wi = twIm[st];
        for (let i = 0; i < M; i += size) {
          for (let j = 0; j < h; j++) {
            const a = i + j, b = a + h, c = wr[j], sn = wi[j];
            const tr = re[b] * c - im[b] * sn;
            const ti = re[b] * sn + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      const base = t * HOP;
      for (let n = 0; n < M; n++) {
        y[base + 2 * n] += re[n] * win[2 * n];
        y[base + 2 * n + 1] += im[n] * win[2 * n + 1];
      }
    }
    for (let j = 0; j < SEG; j++) out[outOff + j] += y[ISTFT_OFFSET + j] * invEnv[j];
  };
}

function makeWindow() {
  const w = new Float32Array(SEG);
  w.fill(1);
  const denom = OVERLAP - 1;
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / denom;
    w[i] = v;
    w[SEG - 1 - i] = v;
  }
  return w;
}

/* -------------------------------------------------------------- separation */
/* Just-in-time order. Window i starts at i * STRIDE and cache chunk i holds
   frames [i * STRIDE, (i + 1) * STRIDE), which are final once windows i-1 and i
   have been added. Chunks are separated starting at the playhead, so the page
   can play stems a window after the click instead of after the whole song.
   Walking forward carries the overlap state, so a straight run costs exactly
   one window per chunk and matches the old whole-song pass sample for sample.
   A jump (seek) costs one extra warm-up window to rebuild the overlap. */
const LEAD_FRAMES = 2 * SR;    // aim slightly ahead: the playhead moves while we compute
let targetFrame = 0;

async function separate(job) {
  const t0 = performance.now();
  const { mixL, mixR, length, videoId, title } = job;
  if (!(mixL instanceof Float32Array) || !(mixR instanceof Float32Array)) throw new Error("bad mix buffers");
  if (mixL.length !== length || mixR.length !== length) throw new Error("mix length mismatch");
  if (length < 1) throw new Error("empty audio");
  targetFrame = Math.max(0, Math.min(length - 1, Math.floor(job.startFrame || 0)));
  const engine = await ensureEngine(job.vendorUrl, job.modelUrl);
  const db = await openDB();

  const tDelete = performance.now();
  await deleteSongData(db, videoId);
  const deleteMs = performance.now() - tDelete;

  const inName = session.inputNames[0];
  const istft = makeIstft();
  const stemsBuf = new Float32Array(STEMS * 2 * SEG);
  const inData = new Float32Array(2 * SEG);
  const input = new ort.Tensor("float32", inData, [1, 2, SEG]);
  const windowW = makeWindow();

  const acc = [];
  for (let s = 0; s < STEMS; s++) acc.push(new Float32Array(2 * SEG));
  const weight = new Float32Array(SEG);

  const cacheBufs = [];
  for (let s = 0; s < STEMS; s++) cacheBufs.push(new Int16Array(STRIDE * 2));
  let cacheWriteMs = 0;

  const sumSq = new Float64Array(STEMS);
  const peak = new Float64Array(STEMS);
  const sampSum = new Float64Array(STEMS);
  const sampSq = new Float64Array(STEMS);
  const cross = new Float64Array(STEMS * STEMS);
  let sampled = 0;
  const CORR_STRIDE = 16;
  const vals = new Float32Array(STEMS);
  const invWeight = new Float32Array(STRIDE);
  // 250 ms peak envelope per stem: lets the page pick a tight, still-guaranteed
  // peak-safe master gain instead of the very conservative whole-song sum.
  const BLOCK_FRAMES = SR / 4;
  const blockCount = Math.ceil(length / BLOCK_FRAMES);
  const blockPeaks = new Float32Array(STEMS * blockCount);

  const nChunks = Math.max(1, Math.ceil(length / STRIDE));
  const chunkDone = new Uint8Array(nChunks);
  let chunksDone = 0, warmups = 0, istftMs = 0;
  const chunkTimes = [];
  const totalAudioSec = length / SR;
  let lastProgressPost = 0;

  const meta = {
    videoId: videoId,
    title: title || "",
    length: length,
    duration: length / SR,
    sampleRate: SR,
    chunkFrames: STRIDE,
    chunkCount: nChunks,
    storeScale: STORE_SCALE,
    blockFrames: BLOCK_FRAMES,
    blockCount: blockCount,
    model: "htdemucs_6s_web",
    engine: engineInfo,
  };
  post({ type: "started", meta: meta });

  function resetOverlap() {
    for (let s = 0; s < STEMS; s++) acc[s].fill(0);
    weight.fill(0);
  }

  async function runWindow(i) {
    const start = i * STRIDE;
    const clen = Math.min(SEG, length - start);
    inData.fill(0);
    inData.set(mixL.subarray(start, start + clen), 0);
    inData.set(mixR.subarray(start, start + clen), SEG);
    const tRun = performance.now();
    const out = await runModel({ [inName]: input });
    chunkTimes.push(performance.now() - tRun);
    // stems = time branch + inverse STFT of the frequency branch
    const tIstft = performance.now();
    const data = stemsBuf;
    data.set(out.wave.data);
    const spec = out.spec.data;
    for (let sig = 0; sig < STEMS * 2; sig++) istft(spec, sig, data, sig * SEG);
    istftMs += performance.now() - tIstft;
    for (let s = 0; s < STEMS; s++) {
      const a = acc[s];
      const base = s * 2 * SEG;
      for (let c = 0; c < 2; c++) {
        const off = base + c * SEG;
        const aoff = c * SEG;
        for (let t = 0; t < clen; t++) a[aoff + t] += data[off + t] * windowW[t];
      }
    }
    for (let t = 0; t < clen; t++) weight[t] += windowW[t];
  }

  function shiftOverlap() {
    for (let s = 0; s < STEMS; s++) {
      const a = acc[s];
      a.copyWithin(0, STRIDE, SEG);
      a.copyWithin(SEG, SEG + STRIDE, 2 * SEG);
      a.fill(0, SEG - STRIDE, SEG);
      a.fill(0, 2 * SEG - STRIDE, 2 * SEG);
    }
    weight.copyWithin(0, STRIDE, SEG);
    weight.fill(0, SEG - STRIDE, SEG);
  }

  // Normalise the first `take` frames of the accumulator into int16 chunk
  // buffers and fold them into the whole-song statistics.
  function flush(chunkBase, take) {
    for (let t = 0; t < take; t++) {
      const wt = weight[t];
      invWeight[t] = wt > 1e-8 ? 1 / wt : 1e8;
    }
    const blkStart = (chunkBase / BLOCK_FRAMES) | 0;
    const blkRemain = BLOCK_FRAMES - (chunkBase - blkStart * BLOCK_FRAMES);
    for (let s = 0; s < STEMS; s++) {
      const a = acc[s], buf = cacheBufs[s], base = s * blockCount;
      let ssq = 0, pk = 0;
      let blk = base + blkStart;
      let left = blkRemain;
      for (let t = 0; t < take; t++) {
        const iw = invWeight[t];
        const l = a[t] * iw;
        const r = a[SEG + t] * iw;
        let li = Math.round(l * I16);
        let ri = Math.round(r * I16);
        if (li > 32767) li = 32767; else if (li < -32768) li = -32768;
        if (ri > 32767) ri = 32767; else if (ri < -32768) ri = -32768;
        buf[2 * t] = li;
        buf[2 * t + 1] = ri;
        ssq += l * l + r * r;
        let m = l + r;
        if (m < 0) m = -m;
        m *= 0.5;
        if (m > pk) pk = m;
        if (m > blockPeaks[blk]) blockPeaks[blk] = m;
        if (--left === 0) { left = BLOCK_FRAMES; blk++; }
      }
      sumSq[s] += ssq;
      if (pk > peak[s]) peak[s] = pk;
    }
    // Correlation on every 16th frame (mono sum), independent pass.
    const first = (CORR_STRIDE - (chunkBase % CORR_STRIDE)) % CORR_STRIDE;
    for (let t = first; t < take; t += CORR_STRIDE) {
      const iw = invWeight[t];
      sampled++;
      for (let s = 0; s < STEMS; s++) vals[s] = (acc[s][t] + acc[s][SEG + t]) * iw * 0.5;
      for (let s = 0; s < STEMS; s++) {
        const v = vals[s];
        sampSum[s] += v;
        sampSq[s] += v * v;
        for (let q = s; q < STEMS; q++) {
          const p = v * vals[q];
          cross[s * STEMS + q] += p;
          if (q !== s) cross[q * STEMS + s] += p;
        }
      }
    }
  }

  // The first unfinished chunk at or after the playhead, else the first unfinished one.
  function nextChunk() {
    const want = Math.min(nChunks - 1, Math.floor((targetFrame + LEAD_FRAMES) / STRIDE));
    for (let c = want; c < nChunks; c++) if (!chunkDone[c]) return c;
    for (let c = 0; c < want; c++) if (!chunkDone[c]) return c;
    return -1;
  }

  let prev = -2;
  while (chunksDone < nChunks) {
    if (cancelled) throw new Error("cancelled");
    const c = nextChunk();
    if (c !== prev + 1) {
      resetOverlap();
      if (c > 0) {
        await runWindow(c - 1);
        shiftOverlap();
        warmups++;
        if (cancelled) throw new Error("cancelled");
      }
    }
    await runWindow(c);
    const chunkBase = c * STRIDE;
    const take = Math.min(STRIDE, length - chunkBase);
    flush(chunkBase, take);
    shiftOverlap();
    prev = c;

    const tWrite = performance.now();
    await putChunkSet(db, videoId, c, cacheBufs, take);
    cacheWriteMs += performance.now() - tWrite;
    chunkDone[c] = 1;
    chunksDone++;
    const b0 = (chunkBase / BLOCK_FRAMES) | 0;
    const b1 = Math.min(blockCount, Math.ceil((chunkBase + take) / BLOCK_FRAMES));
    const peaks = [];
    for (let s = 0; s < STEMS; s++) peaks.push(Array.from(blockPeaks.subarray(s * blockCount + b0, s * blockCount + b1)));
    post({ type: "chunk-ready", videoId: videoId, chunk: c, blockStart: b0, blockPeaks: peaks });

    const elapsed = performance.now() - t0;
    if (performance.now() - lastProgressPost > 120 || chunksDone === nChunks) {
      lastProgressPost = performance.now();
      const audioDone = Math.min(totalAudioSec, chunksDone * STRIDE / SR);
      post({
        type: "progress", done: chunksDone, total: nChunks,
        chunkMs: chunkTimes[chunkTimes.length - 1],
        avgMs: elapsed / chunksDone,
        elapsedMs: elapsed,
        audioDoneSec: audioDone,
        audioTotalSec: totalAudioSec,
        rtf: elapsed / 1000 / Math.max(0.001, audioDone),
        etaMs: Math.max(0, (nChunks - chunksDone) * (elapsed / chunksDone)),
        cacheWritten: chunksDone,
        cacheTotal: nChunks,
        firstChunkMs: chunksDone === 1 ? elapsed : undefined,
      });
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  const corr = [], varArr = new Float64Array(STEMS);
  if (sampled > 0) {
    for (let s = 0; s < STEMS; s++) {
      const mean = sampSum[s] / sampled;
      varArr[s] = Math.max(1e-12, sampSq[s] / sampled - mean * mean);
    }
    for (let i2 = 0; i2 < STEMS; i2++) {
      corr.push([]);
      for (let j2 = 0; j2 < STEMS; j2++) {
        const mi = sampSum[i2] / sampled, mj = sampSum[j2] / sampled;
        const cov = cross[i2 * STEMS + j2] / sampled - mi * mj;
        corr[i2].push(cov / (Math.sqrt(varArr[i2] * varArr[j2]) || 1e-9));
      }
    }
  } else {
    for (let s = 0; s < STEMS; s++) corr.push([1, 0, 0, 0, 0, 0]);
  }
  let corrMin = 1, corrMax = -1;
  for (let i2 = 0; i2 < STEMS; i2++) for (let j2 = i2 + 1; j2 < STEMS; j2++) {
    const v = corr[i2][j2];
    if (v < corrMin) corrMin = v;
    if (v > corrMax) corrMax = v;
  }

  const stemRms = [], stemPeak = [];
  for (let s = 0; s < STEMS; s++) {
    stemRms.push(Math.sqrt(sumSq[s] / (2 * length)));
    stemPeak.push(peak[s]);
  }
  const totalMs = performance.now() - t0;
  Object.assign(meta, {
    blockPeaks: Array.from(blockPeaks),
    stemRms: stemRms,
    stemPeak: stemPeak,
    corrMin: corrMin,
    corrMax: corrMax,
    createdAt: Date.now(),
  });
  // Written last: a song only counts as cached once every chunk is in.
  const tMeta = performance.now();
  await putSongMeta(db, meta);
  cacheWriteMs += performance.now() - tMeta;
  try { db.close(); } catch (e) {}

  post({
    type: "ready",
    meta: meta,
    stats: { stemRms: stemRms, stemPeak: stemPeak, corrMin: corrMin, corrMax: corrMax, corr: corr },
    timings: {
      engineMs: engine.totalMs,
      createMs: engine.createMs,
      warmMs: engine.warmMs,
      separateMs: totalMs,
      cacheWriteMs: cacheWriteMs,
      deleteMs: deleteMs,
      chunks: nChunks,
      warmups: warmups,
      istftMs: Math.round(istftMs),
      chunkTimes: chunkTimes.map((x) => +x.toFixed(1)),
      audioSec: totalAudioSec,
      rtf: totalMs / 1000 / totalAudioSec,
      totalMs: performance.now() - t0,
    },
  });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "init") {
      await ensureEngine(m.vendorUrl, m.modelUrl);
      post({ type: "engine-ready", info: engineInfo });
    } else if (m.type === "separate") {
      cancelled = false;
      await separate(m);
    } else if (m.type === "priority") {
      targetFrame = Math.max(0, Math.floor(m.frame || 0));
    } else if (m.type === "cancel") {
      cancelled = true;
    }
  } catch (err) {
    post({ type: "error", message: String(err && err.stack || err), stage: m.type });
  }
};