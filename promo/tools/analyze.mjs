// Per-band loudness at 30 fps (drives the mixer meters) and an onset envelope at 100 Hz (beat
// fitting) for one clip, from mono float32 PCM at 22.05 kHz written by scripts/prepare.sh.
// usage: node tools/analyze.mjs <name>   reads work/pcm/<name>.f32, writes src/data/<name>.*.json
import fs from 'node:fs';
const SR = 22050, FPS = 30;
const name = process.argv[2];
const ROOT = new URL('../', import.meta.url);
const buf = fs.readFileSync(new URL(`work/pcm/${name}.f32`, ROOT));
const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);

function biquad(sig, type, f, q = 0.707) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; } // bandpass, constant peak gain
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = (b0 * sig[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = sig[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const rmsFrames = (sig, hop) => {
  const n = Math.floor(sig.length / hop), out = new Float32Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let i = k * hop; i < (k + 1) * hop; i++) s += sig[i] * sig[i]; out[k] = Math.sqrt(s / hop); }
  return out;
};

// bands for the visualiser
const bands = {
  bass: biquad(biquad(x, 'lp', 140), 'lp', 140),
  drums: biquad(biquad(x, 'hp', 5000), 'hp', 5000),
  vocals: biquad(x, 'bp', 1800, 0.9),
  other: biquad(x, 'bp', 600, 1.2),
  guitar: biquad(x, 'bp', 2800, 1.5),
  piano: biquad(x, 'bp', 1000, 1.5),
};
const hop30 = SR / FPS;
const env = {};
for (const [k, s] of Object.entries(bands)) env[k] = Array.from(rmsFrames(s, hop30), v => +v.toFixed(5));
env.full = Array.from(rmsFrames(x, hop30), v => +v.toFixed(5));

// onset envelope at 100 Hz: half-wave rectified log-energy diff over low + high bands
const H = Math.round(SR / 100);
const lo = rmsFrames(biquad(x, 'lp', 200), H), hi = rmsFrames(biquad(x, 'hp', 3000), H);
const on = new Float32Array(lo.length);
for (let i = 1; i < lo.length; i++) {
  on[i] = Math.max(0, Math.log(lo[i] + 1e-4) - Math.log(lo[i - 1] + 1e-4)) + Math.max(0, Math.log(hi[i] + 1e-4) - Math.log(hi[i - 1] + 1e-4));
}
fs.writeFileSync(new URL(`src/data/${name}.onset.json`, ROOT), JSON.stringify(Array.from(on, v => +v.toFixed(4))));
fs.writeFileSync(new URL(`src/data/${name}.env.json`, ROOT), JSON.stringify(env));

// tempo by autocorrelation, 70..180 bpm, over a window
function tempo(a, b) {
  const seg = on.slice(a * 100, b * 100); let best = 0, bl = 0;
  for (let lag = Math.round(6000 / 180); lag <= Math.round(6000 / 70); lag++) {
    let s = 0; for (let i = lag; i < seg.length; i++) s += seg[i] * seg[i - lag];
    s /= (seg.length - lag); if (s > best) { best = s; bl = lag; }
  }
  return 6000 / bl;
}
const dur = x.length / SR;
console.log(name, 'dur', dur.toFixed(2));
for (let a = 0; a + 10 <= dur; a += 8) console.log(`  ${a}-${a + 10}s bpm ${tempo(a, a + 10).toFixed(1)}`);
