import { Composition } from 'remotion';
import { Reel, ReelProps } from './Reel';
import { FPS, TOTAL } from './timeline';

export const Root = () => (
  <Composition
    id="Reel"
    component={Reel}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={TOTAL}
    defaultProps={{ lang: 'en' } as ReelProps}
  />
);
