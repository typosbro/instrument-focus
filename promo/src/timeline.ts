import tempo from './data/tempo.json';

export const FPS = 30;
export const PERIOD = tempo.period; // seconds per beat, 111.15 bpm
export const BEAT = PERIOD * FPS; // frames per beat

// Stem order everywhere: drums, bass, other, vocals, guitar, piano.
export type Gains = [number, number, number, number, number, number];
const FLAT: Gains = [0, 0, 0, 0, 0, 0];
const solo = (i: number): Gains => FLAT.map((_, k) => (k === i ? 12 : -24)) as Gains;

export type Kind = 'mv' | 'reveal' | 'end';
export type SegDef = {
  id: 'hook' | 'vocals' | 'drums' | 'bass' | 'mix' | 'reveal' | 'end';
  src: 'flat' | 'demo';
  at: number; // source start in seconds, snapped to a local beat
  beats: number;
  gains: Gains;
  kind: Kind;
};

// Fader states are the ones actually set in the recording at these source times.
const DEFS: SegDef[] = [
  { id: 'hook', src: 'flat', at: 18.14, beats: 4, gains: FLAT, kind: 'mv' },
  { id: 'vocals', src: 'demo', at: 19.39, beats: 8, gains: solo(3), kind: 'mv' },
  { id: 'drums', src: 'demo', at: 52.0, beats: 8, gains: solo(0), kind: 'mv' },
  { id: 'bass', src: 'demo', at: 42.59, beats: 6, gains: solo(1), kind: 'mv' },
  { id: 'mix', src: 'demo', at: 30.41, beats: 3, gains: [-24, 12, -24, 12, -24, -24], kind: 'mv' },
  { id: 'reveal', src: 'demo', at: 4.29, beats: 8, gains: FLAT, kind: 'reveal' },
  { id: 'end', src: 'demo', at: 58.49, beats: 7, gains: solo(0), kind: 'end' },
];

export type Seg = SegDef & { from: number; dur: number; prev: Gains };
let beatAcc = 0;
export const SEGS: Seg[] = DEFS.map((d, i) => {
  const from = Math.round(beatAcc * BEAT);
  beatAcc += d.beats;
  const dur = Math.round(beatAcc * BEAT) - from;
  return { ...d, from, dur, prev: i === 0 ? DEFS[DEFS.length - 1].gains : DEFS[i - 1].gains };
});
export const TOTAL = Math.round(beatAcc * BEAT);

// The reveal shot, in demo-recording seconds and source pixels (1280x720 take). The Drums preset
// is clicked at 6.8 s (drums +9, the rest -6); the camera dives onto the panel's preset and fader
// block just before, and a ripple marks the click on the Drums chip.
export const REVEAL = { click: 6.8, srcW: 1280, srcH: 720, focus: [1072, 555], chip: [1072, 469] } as const;
