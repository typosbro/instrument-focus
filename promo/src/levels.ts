import flatEnv from './data/flat.env.json';
import demoEnv from './data/demo.env.json';

// Per-band loudness of the recorded output at 30 fps (see tools/analyze.mjs). The recording is
// the extension's output, so a soloed stem's band already carries the change; the fader gain
// is applied on top so muted strips read as silent.
type Env = Record<'bass' | 'drums' | 'vocals' | 'other' | 'guitar' | 'piano' | 'full', number[]>;
const ENV: Record<'flat' | 'demo', Env> = { flat: flatEnv as Env, demo: demoEnv as Env };
const BANDS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const;

// Normalise each band to its 95th percentile over the full-mix clip.
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] || 1;
const NORM = Object.fromEntries(BANDS.map(b => [b, p95(ENV.flat[b])])) as Record<string, number>;

const raw = (src: 'flat' | 'demo', band: string, f: number) =>
  (ENV[src][band as keyof Env][f] ?? 0) / NORM[band];

// Meter value 0..1 with a fast attack and a ~200 ms release, computed statelessly.
export function meter(src: 'flat' | 'demo', stem: number, srcFrame: number, gainDb: number) {
  const band = BANDS[stem];
  let v = 0;
  for (let k = 0; k < 7; k++) v = Math.max(v, raw(src, band, srcFrame - k) * Math.pow(0.72, k));
  const db = 20 * Math.log10(v * Math.pow(10, gainDb / 20) + 1e-6);
  return Math.min(1, Math.max(0, (db + 22) / 28));
}
