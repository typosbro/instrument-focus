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
  if (session) return engineInfo;
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
      // wasm is paired only because ORT-web lacks WebGPU kernels for a handful
      // of shape ops in /real_istft. This is not a whole-model WASM fallback.
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });
    const createMs = performance.now() - tCreate;
    post({ type: "engine-status", msg: "session created in " + Math.round(createMs) + " ms", createMs: createMs });
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
  const outName = session.outputNames[0];
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
  let chunksDone = 0, warmups = 0;
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
    const out = await session.run({ [inName]: input });
    const data = out[outName].data;
    chunkTimes.push(performance.now() - tRun);
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