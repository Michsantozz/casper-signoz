import { Composition } from "remotion";
import { CasperDemo } from "./compositions/CasperDemo";

// The recorded session is 145.68s at 25fps. We render the demo composition at
// 30fps; <OffthreadVideo> is time-based, so it plays in real time regardless of
// the composition fps. Duration below is in the composition's own 30fps timeline.
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
// 145.68s of footage → round up so the last frame isn't clipped.
export const DURATION_IN_FRAMES = Math.ceil(145.68 * FPS); // 4371

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CasperDemo"
      component={CasperDemo}
      durationInFrames={DURATION_IN_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
