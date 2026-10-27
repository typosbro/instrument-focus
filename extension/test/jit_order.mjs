// Offline check of the just-in-time worker loop, no GPU and no browser.
//
//   node extension/test/jit_order.mjs
//
// Runs src/engine.worker.js in a vm with a fake ONNX session whose output
// depends non-linearly on the whole input window, so a wrong overlap-add after
// a jump shows up as a sample mismatch. Checks:
//   1. the first chunk written is the one at the requested playhead,
//   2. a run with a mid-song seek writes every chunk exactly once,
//   3. every chunk is bit-identical to a straight 0..N pass.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "../src/engine.worker.js"), "utf8")
  // expose the engine bindings so the fake can install itself
  .replace("let ort = null;", "var ort = null;")
  .replace("let session = null;", "var session = null;");

const SR = 44100, SEG = 343980, STEMS = 6;

function makeWorker() {
  const posted = [];
  const chunks = new Map();
  const writeOrder = [];
  const ctx = {
    console, performance, setTimeout, Math, Float32Array, Float64Array, Int16Array, Uint8Array, Array, Object, Error, Promise, String,
    self: { postMessage: (m) => posted.push(m) },
    navigator: {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  ctx.ort = { Tensor };
  ctx.session = {
    inputNames: ["mix"], outputNames: ["out"],
    async run(feeds) {
      const x = feeds.mix.data;
      let mean = 0;
      for (let i = 0; i < x.length; i++) mean += x[i];
      mean /= x.length;
      const out = new Float32Array(STEMS * 2 * SEG);
      for (let s = 0; s < STEMS; s++) for (let i = 0; i < 2 * SEG; i++) {
        out[s * 2 * SEG + i] = 0.1 * x[i] * (1 + s) * (1 + 4 * mean) + 0.01 * Math.tanh(x[i] * 7 + s);
      }
      return { out: { data: out } };
    },
  };
  ctx.engineInfo = { totalMs: 0, createMs: 0, warmMs: 0 };
  ctx.ensureEngine = async () => ctx.engineInfo;
  ctx.openDB = async () => ({ close() {} });
  ctx.deleteSongData = async () => {};
  ctx.putSongMeta = async () => {};
  ctx.putChunkSet = async (db, vid, c, bufs, frames) => {
    writeOrder.push(c);
    chunks.set(c, bufs.map((b) => b.slice(0, frames * 2)));
  };
  return { ctx, posted, chunks, writeOrder };
}

function mix(len) {
  const L = new Float32Array(len), R = new Float32Array(len);
  let seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = (seed / 4294967296 - 0.5) * 0.2;
    L[i] = 0.4 * Math.sin(i * 0.013) + n;
    R[i] = 0.3 * Math.sin(i * 0.007 + 1) - n;
  }
  return { L, R };
}

async function run(len, startSec, seekAtChunk, seekSec) {
  const w = makeWorker();
  const { L, R } = mix(len);
  if (seekAtChunk != null) {
    const orig = w.ctx.putChunkSet;
    w.ctx.putChunkSet = async (...a) => {
      await orig(...a);
      if (w.writeOrder.length === seekAtChunk) w.ctx.self.onmessage({ data: { type: "priority", frame: Math.floor(seekSec * SR) } });
    };
  }
  await w.ctx.self.onmessage({ data: {
    type: "separate", videoId: "t", title: "t", mixL: L, mixR: R, length: len,
    startFrame: Math.floor(startSec * SR),
  } });
  const err = w.posted.find((m) => m.type === "error");
  if (err) throw new Error(err.message);
  return w;
}

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); }

const len = Math.floor(61.3 * SR);           // 11 chunks, short last chunk
const base = await run(len, 0);
const n = Math.ceil(len / (SEG - (SEG >> 2)));
assert(base.writeOrder.join() === [...Array(n).keys()].join(), "straight pass writes 0.." + (n - 1) + " in order");

const jit = await run(len, 30, 3, 10);       // start at 30 s, seek back to 10 s after 3 chunks
const first = jit.writeOrder[0];
assert(first === Math.floor((30 + 2) * SR / (SEG - (SEG >> 2))), "first chunk is at the playhead + lead (chunk " + first + ")");
assert(jit.writeOrder[3] === Math.floor((10 + 2) * SR / (SEG - (SEG >> 2))), "after the seek the next chunk jumps to the new playhead");
assert(new Set(jit.writeOrder).size === n && jit.writeOrder.length === n, "every chunk written exactly once (" + jit.writeOrder.join(",") + ")");

let maxDiff = 0;
for (let c = 0; c < n; c++) for (let s = 0; s < STEMS; s++) {
  const a = base.chunks.get(c)[s], b = jit.chunks.get(c)[s];
  if (a.length !== b.length) { maxDiff = Infinity; break; }
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
}
assert(maxDiff === 0, "jumped run is bit-identical to the straight pass (max int16 diff " + maxDiff + ")");

const ready = jit.posted.filter((m) => m.type === "ready")[0];
const bReady = base.posted.filter((m) => m.type === "ready")[0];
assert(ready && ready.meta.chunkCount === n && ready.timings.warmups >= 2, "ready meta complete, warm-ups " + ready.timings.warmups);
const rmsDiff = Math.max(...ready.meta.stemRms.map((v, i) => Math.abs(v - bReady.meta.stemRms[i])));
const bpDiff = Math.max(...ready.meta.blockPeaks.map((v, i) => Math.abs(v - bReady.meta.blockPeaks[i])));
assert(rmsDiff < 1e-9 && bpDiff === 0, "stats match the straight pass (rms diff " + rmsDiff.toExponential(1) + ")");
assert(jit.posted.filter((m) => m.type === "chunk-ready").length === n, "one chunk-ready message per chunk");
