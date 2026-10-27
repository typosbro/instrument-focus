import React from 'react';
import {
  AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, staticFile,
  useCurrentFrame, useVideoConfig, Easing,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';
import { COPY } from './copy';
import { BEAT, FPS, Gains, REVEAL, SEGS, Seg } from './timeline';
import { meter } from './levels';

const { fontFamily } = loadFont('normal', { weights: ['500', '700', '900'], subsets: ['latin', 'latin-ext'] });

export type ReelProps = { lang: 'en' | 'uz' };

export const STEM_COLORS = ['#FF5A5F', '#8B6CFF', '#9AA6B8', '#FFC53D', '#3DDC97', '#4CC9F0'];
const ACCENT: Record<Seg['id'], string> = {
  hook: '#FFFFFF', vocals: STEM_COLORS[3], drums: STEM_COLORS[0], bass: STEM_COLORS[1],
  mix: '#FFC53D', reveal: '#FFC53D', end: '#FFC53D',
};
const MV = { demo: staticFile('demo_mv.mp4'), flat: staticFile('flat_mv.mp4') };
const BG = '#08080B';

// Layout, kept clear of the Reels UI (top bar, right rail, caption block at the bottom).
const CARD = { x: 60, y: 470, w: 960, h: 716 };
const MIXER = { x: 60, y: 1222, w: 900, h: 370 };

export const Reel: React.FC<ReelProps> = ({ lang }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily }}>
      {SEGS.map(s => (
        <Sequence key={s.id} from={s.from} durationInFrames={s.dur} name={s.id}>
          <Audio src={MV[s.src]} trimBefore={Math.round(s.at * FPS)} volume={f => fade(f, s.dur)} />
          <Scene seg={s} lang={lang} />
        </Sequence>
      ))}
      <BeatGlow />
      <Watermark text="Instrument Focus" />
    </AbsoluteFill>
  );
};

// 2-frame fades at every cut so hard edits never click.
const fade = (f: number, dur: number) =>
  Math.min(1, interpolate(f, [0, 2], [0, 1], { extrapolateRight: 'clamp' }),
    interpolate(f, [dur - 2, dur], [1, 0], { extrapolateLeft: 'clamp' }));

const Scene: React.FC<{ seg: Seg; lang: 'en' | 'uz' }> = ({ seg, lang }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const c = COPY[lang];
  const srcFrame = Math.round(seg.at * FPS) + f;
  const isReveal = seg.kind === 'reveal';
  const isEnd = seg.kind === 'end';

  // Faders fly from the previous scene's state to this one's.
  const t = spring({ frame: f, fps, config: { damping: 16, stiffness: 140 }, durationInFrames: 14 });
  const gains = seg.gains.map((g, i) => seg.prev[i] + (g - seg.prev[i]) * t) as Gains;

  return (
    <AbsoluteFill>
      <BlurBackdrop seg={seg} />
      {isReveal ? <Reveal seg={seg} /> : <VideoCard seg={seg} dim={isEnd} />}
      <Headline text={c.head[seg.id]} accent={ACCENT[seg.id]} sub={c.sub[seg.id]} />
      {!isReveal && <Mixer src={seg.src} srcFrame={srcFrame} gains={gains} names={c.stems} enter={seg.id === 'hook'} />}
      {isEnd && <Cta lang={lang} />}
      <Flash />
    </AbsoluteFill>
  );
};

const BlurBackdrop: React.FC<{ seg: Seg }> = ({ seg }) => (
  <AbsoluteFill style={{ overflow: 'hidden' }}>
    <OffthreadVideo
      src={MV[seg.src]} muted trimBefore={Math.round(seg.at * FPS)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(70px) saturate(1.6)', transform: 'scale(1.4)', opacity: 0.55 }}
    />
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${BG}EE 0%, ${BG}66 30%, ${BG}88 60%, ${BG}F2 100%)` }} />
  </AbsoluteFill>
);

const VideoCard: React.FC<{ seg: Seg; dim: boolean }> = ({ seg, dim }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Punch-in on the cut, then a slow push for the rest of the scene.
  const punch = spring({ frame: f, fps, config: { damping: 12, stiffness: 160 }, from: 1.16, to: 1 });
  const push = interpolate(f, [0, seg.dur], [1, 1.06]);
  const tilt = interpolate(spring({ frame: f, fps, config: { damping: 14 } }), [0, 1], [seg.id === 'hook' ? 0 : -2.5, 0]);
  const dimV = dim ? interpolate(f, [0, 12], [1, 0.45], { extrapolateRight: 'clamp' }) : 1;
  return (
    <div style={{
      position: 'absolute', left: CARD.x, top: CARD.y, width: CARD.w, height: CARD.h, borderRadius: 40,
      overflow: 'hidden', transform: `rotate(${tilt}deg) scale(${beatBump(seg.from + f)})`,
      boxShadow: `0 40px 120px #000C, 0 0 0 2px ${ACCENT[seg.id]}33`,
    }}>
      <OffthreadVideo
        src={MV[seg.src]} muted trimBefore={Math.round(seg.at * FPS)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transformOrigin: '50% 0%', transform: `scale(${punch * push * 1.13})`, filter: `brightness(${dimV})` }}
      />
    </div>
  );
};

// The real recording: the browser window flies in, then the camera dives onto the panel
// as the Drums preset is clicked.
const Reveal: React.FC<{ seg: Seg }> = ({ seg }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: f, fps, config: { damping: 15, stiffness: 90 } });
  const clickF = Math.round((REVEAL.click - seg.at) * FPS);
  const dive = interpolate(f, [clickF - 26, clickF - 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.7, 0, 0.2, 1) });
  const W = 960, H = 540;
  const fx = REVEAL.focus[0] / REVEAL.srcW, fy = REVEAL.focus[1] / REVEAL.srcH, zoom = 1 + dive * 1.45;
  const ox = (0.5 - fx) * W * zoom * dive, oy = (0.5 - fy) * H * zoom * dive;
  const ring = interpolate(f, [clickF, clickF + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rx = (REVEAL.chip[0] / REVEAL.srcW) * W, ry = (REVEAL.chip[1] / REVEAL.srcH) * H;
  return (
    <div style={{
      position: 'absolute', left: CARD.x, top: CARD.y + 70, width: W, height: H + 120,
      perspective: 1600,
    }}>
      <div style={{
        width: W, height: H, borderRadius: 28, overflow: 'hidden', position: 'relative',
        transform: `translateY(${(1 - enter) * 420}px) rotateX(${(1 - enter) * 38}deg) scale(${0.86 + enter * 0.14})`,
        boxShadow: '0 50px 140px #000E, 0 0 0 2px #FFC53D55',
      }}>
        <div style={{ position: 'absolute', inset: 0, transform: `translate(${ox}px, ${oy}px) scale(${zoom})`, transformOrigin: '50% 50%' }}>
          <OffthreadVideo src={staticFile('demo_screen.mp4')} muted trimBefore={Math.round(seg.at * FPS)} style={{ width: W, height: H }} />
          {ring > 0 && ring < 1 && (
            <div style={{
              position: 'absolute', left: rx - 40, top: ry - 40, width: 80, height: 80, borderRadius: 40,
              border: `${6 * (1 - ring)}px solid #FFC53D`, transform: `scale(${0.4 + ring * 1.6})`, opacity: 1 - ring,
            }} />
          )}
        </div>
      </div>
      <div style={{ marginTop: 40, display: 'flex', justifyContent: 'center', gap: 18, opacity: enter }}>
        {['WebGPU', 'HTDemucs 6-stem', 'offline'].map(b => (
          <div key={b} style={{ padding: '12px 24px', borderRadius: 999, background: '#FFFFFF14', border: '1px solid #FFFFFF26', color: '#E8EAF0', fontSize: 30, fontWeight: 700 }}>{b}</div>
        ))}
      </div>
    </div>
  );
};

const Headline: React.FC<{ text: string; accent: string; sub?: string }> = ({ text, accent, sub }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  return (
    <div style={{ position: 'absolute', left: 50, right: 50, top: 200, height: 250, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: 22, rowGap: 0 }}>
        {words.map((w, i) => {
          const hi = w.startsWith('*');
          const s = spring({ frame: f - i * 2, fps, config: { damping: 11, stiffness: 180 } });
          return (
            <span key={i} style={{
              display: 'inline-block', fontSize: 92, fontWeight: 900, lineHeight: 1.08, letterSpacing: -2,
              color: hi ? accent : '#FFFFFF', opacity: s,
              transform: `translateY(${(1 - s) * 50}px) scale(${0.7 + s * 0.3}) rotate(${(1 - s) * (i % 2 ? 6 : -6)}deg)`,
              textShadow: hi ? `0 0 40px ${accent}88` : '0 6px 30px #000A',
            }}>{w.replace(/\*/g, '')}</span>
          );
        })}
      </div>
      {sub && (
        <div style={{
          marginTop: 22, fontSize: 36, fontWeight: 600, color: '#C9CED8',
          opacity: interpolate(f, [8, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}>{sub}</div>
      )}
    </div>
  );
};

const Mixer: React.FC<{ src: 'flat' | 'demo'; srcFrame: number; gains: Gains; names: string[]; enter: boolean }> = ({ src, srcFrame, gains, names, enter }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inS = enter ? spring({ frame: f - 6, fps, config: { damping: 14 } }) : 1;
  const colW = MIXER.w / 6, trackH = 250;
  const pos = (db: number) => 1 - (db + 24) / 36; // 0 at +12 dB, 1 at -24 dB
  return (
    <div style={{
      position: 'absolute', left: MIXER.x, top: MIXER.y, width: MIXER.w, height: MIXER.h,
      borderRadius: 34, background: '#101016D9', border: '1px solid #FFFFFF1A',
      boxShadow: '0 30px 90px #000B', display: 'flex', padding: '26px 0 22px',
      opacity: inS, transform: `translateY(${(1 - inS) * 140}px)`,
    }}>
      {gains.map((gRaw, i) => {
        const g = Math.min(12, Math.max(-24, gRaw));
        const m = meter(src, i, srcFrame, g);
        const live = g > -18;
        const col = STEM_COLORS[i];
        return (
          <div key={i} style={{ width: colW, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: live ? 1 : 0.32 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: live ? col : '#8A90A0', fontVariantNumeric: 'tabular-nums', height: 34 }}>
              {Math.round(g) > 0 ? '+' : ''}{Math.round(g)}
            </div>
            <div style={{ position: 'relative', width: 70, height: trackH, marginTop: 6 }}>
              <div style={{ position: 'absolute', left: 31, top: 0, width: 8, height: trackH, borderRadius: 4, background: '#FFFFFF14' }} />
              <div style={{
                position: 'absolute', left: 17, bottom: 0, width: 36, height: Math.max(4, m * trackH), borderRadius: 10,
                background: `linear-gradient(180deg, ${col}, ${col}55)`, boxShadow: live ? `0 0 ${18 + m * 30}px ${col}AA` : 'none',
              }} />
              <div style={{
                position: 'absolute', left: 0, top: pos(g) * trackH - 13, width: 70, height: 26, borderRadius: 8,
                background: 'linear-gradient(180deg,#FFFFFF,#C9CCD6)', boxShadow: '0 4px 14px #000C',
              }} />
            </div>
            <div style={{ marginTop: 14, fontSize: 25, fontWeight: 700, color: live ? '#FFFFFF' : '#8A90A0' }}>{names[i]}</div>
          </div>
        );
      })}
    </div>
  );
};

const Cta: React.FC<{ lang: 'en' | 'uz' }> = ({ lang }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const c = COPY[lang].cta;
  const s = spring({ frame: f - 4, fps, config: { damping: 12 } });
  const bob = Math.sin((f / BEAT) * Math.PI) * 8;
  return (
    <div style={{
      position: 'absolute', left: CARD.x + 60, top: CARD.y + 150, width: CARD.w - 120, padding: '44px 30px', borderRadius: 36,
      background: '#0B0B10E6', border: '2px solid #FFC53D66', textAlign: 'center',
      transform: `scale(${0.8 + s * 0.2})`, opacity: s, boxShadow: '0 40px 120px #000',
    }}>
      <div style={{ fontSize: 64, fontWeight: 900, color: '#FFFFFF', letterSpacing: -1 }}>{c.title}</div>
      <div style={{ fontSize: 44, fontWeight: 700, color: '#FFC53D', marginTop: 12 }}>{c.stores}</div>
      <div style={{ fontSize: 46, fontWeight: 700, color: '#E8EAF0', marginTop: 34, transform: `translateY(${bob}px)` }}>{c.ask}</div>
    </div>
  );
};

// White flash on every cut.
const Flash: React.FC = () => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 1, 6], [0.55, 0.35, 0], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ backgroundColor: '#FFFFFF', opacity: o, pointerEvents: 'none' }} />;
};

// Subtle scale bump on every beat, decaying over a third of a beat.
const beatBump = (frame: number) => {
  const ph = (frame % BEAT) / BEAT;
  return 1 + 0.012 * Math.max(0, 1 - ph * 3);
};

const BeatGlow: React.FC = () => {
  const f = useCurrentFrame();
  const ph = (f % BEAT) / BEAT;
  const o = 0.22 * Math.max(0, 1 - ph * 2.5);
  return <AbsoluteFill style={{ background: 'radial-gradient(60% 40% at 50% 45%, #FFC53D, transparent 70%)', opacity: o, mixBlendMode: 'screen', pointerEvents: 'none' }} />;
};

const Watermark: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ position: 'absolute', top: 130, width: '100%', textAlign: 'center', fontSize: 26, fontWeight: 700, letterSpacing: 6, color: '#FFFFFF66', textTransform: 'uppercase' }}>{text}</div>
);
