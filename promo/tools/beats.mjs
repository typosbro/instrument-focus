// Fit the song's tempo on a clean, drum-heavy window, then print the beat phase per 4 s window
// of every clip. Segment start times in src/timeline.ts are picked from these phases so each
// cut lands on a beat; phase drifts between sections, so always snap to the local value.
// usage: node tools/beats.mjs <clip> <from> <to>   e.g. demo 49 66 (a drums solo)
import fs from 'node:fs';
const ROOT = new URL('../', import.meta.url);
const [clip, from, to] = [process.argv[2], +process.argv[3], +process.argv[4]];
if (!clip || !(to > from)) { console.error('usage: node tools/beats.mjs <clip> <from> <to>'); process.exit(1); }
const on = n => JSON.parse(fs.readFileSync(new URL(`src/data/${n}.onset.json`, ROOT)));
const at = (o, t) => { const i = t * 100, k = Math.floor(i), f = i - k; return (o[k] ?? 0) * (1 - f) + (o[k + 1] ?? 0) * f; };

const ref = on(clip);
let best = { s: 0 };
for (let bpm = 70; bpm <= 180; bpm += 0.05) for (let ph = 0; ph < 60 / bpm; ph += 0.005) {
  const p = 60 / bpm; let s = 0; for (let t = from + ph; t < to; t += p) s += at(ref, t);
  s /= (to - from) / p; // per-beat mean, so slower tempi are not penalised
  if (s > best.s) best = { s, bpm, ph };
}
const P = 60 / best.bpm;
console.log(`bpm ${best.bpm.toFixed(2)}  period ${P.toFixed(4)} s`);
fs.writeFileSync(new URL('src/data/tempo.json', ROOT), JSON.stringify({ bpm: best.bpm, period: P }));

// first beat at or after each window start, with how strongly the grid fits there
const clips = fs.readdirSync(new URL('src/data/', ROOT)).filter(f => f.endsWith('.onset.json')).map(f => f.replace('.onset.json', ''));
for (const n of clips) {
  const o = on(n), d = o.length / 100, rows = [];
  for (let a = 0; a + 4 <= d; a += 2) {
    let bs = { s: 0, ph: 0 };
    for (let ph = 0; ph < P; ph += 0.005) { let s = 0; for (let t = a + ph; t < a + 4; t += P) s += at(o, t); if (s > bs.s) bs = { s, ph }; }
    rows.push(`${a}s→${(a + bs.ph).toFixed(2)} (${(bs.s / (4 / P)).toFixed(1)})`);
  }
  console.log(`\n${n}: first beat per window (fit strength)\n  ${rows.join('  ')}`);
}
