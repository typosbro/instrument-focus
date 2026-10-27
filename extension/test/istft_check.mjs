// Check the worker's JS inverse STFT against the stock graph's own iSTFT output.
//
//   node extension/test/istft_check.mjs <spec.bin> <slice5.bin>
//
// spec.bin   float32 [1,6,2,2,2049,340]  the graph tensor /Pad_2_output_0
// slice5.bin float32 [1,6,2,343980]      the graph tensor /Slice_5_output_0 (iSTFT, cropped)
// Both come from one ONNX Runtime CPU run of htdemucs_6s_web.onnx (see scripts/build_model.sh).
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = { self: { postMessage() {} }, navigator: {}, console, performance, Math, Float32Array, Float64Array, Uint32Array, Int16Array, Uint8Array };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, "../src/engine.worker.js"), "utf8"), ctx);

const read = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const spec = read(process.argv[2]);
const ref = read(process.argv[3]);
const SEG = 343980;
const istft = ctx.makeIstft();
const out = new Float32Array(12 * SEG);
const t0 = performance.now();
for (let sig = 0; sig < 12; sig++) istft(spec, sig, out, sig * SEG);
const ms = performance.now() - t0;
let maxDiff = 0, maxRef = 0;
for (let i = 0; i < out.length; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
  maxRef = Math.max(maxRef, Math.abs(ref[i]));
}
console.log("12 signals in " + ms.toFixed(0) + " ms; max |diff| " + maxDiff.toExponential(2) + " (ref peak " + maxRef.toFixed(3) + ")");
if (!(maxDiff < 2e-4)) { console.error("FAIL"); process.exit(1); }
console.log("ok");
