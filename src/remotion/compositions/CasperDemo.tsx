import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";

/**
 * CasperDemo — the recorded live agent session (public/casper-session.mp4)
 * played back via <OffthreadVideo>, with animated overlays layered on top:
 *  - an intro title card that fades out
 *  - a lower-third "chapter" label per feature the demo exercises
 *  - a subtle vignette + brand mark for polish
 *
 * The video is REAL (a Playwright-driven session against the live app), so this
 * composition never fakes UI — it only annotates the genuine footage.
 *
 * Chapter timings (seconds) map to the recorded flow. Adjust in the Remotion
 * studio with live preview if the recording is re-captured at a different pace.
 */

const ACCENT = "#34d399"; // matches the app's --thread-accent-primary green
const FONT_STACK =
  '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace';

type Chapter = {
  fromSec: number;
  toSec: number;
  index: string;
  title: string;
  sub: string;
};

// Timings measured frame-by-frame against the 145.68s recording. Each chapter
// annotates the phase on screen: notebook tour → team dynamics/tension → email.
const CHAPTERS: Chapter[] = [
  { fromSec: 4, toSec: 40, index: "01", title: "The meeting notebook", sub: "transcript · summary · key moments" },
  { fromSec: 40, toSec: 66, index: "02", title: "Team dynamics & tension", sub: "talk-time · interruptions · 🔥 moments" },
  { fromSec: 78, toSec: 143, index: "03", title: "Email the minutes", sub: "confirm_send_summary_email" },
];

export const CasperDemo: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#050505" }}>
      {/* The real recorded session. */}
      <OffthreadVideo src={staticFile("casper-session.mp4")} />

      {/* Soft vignette so overlays stay legible over bright UI. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 80% at 50% 50%, transparent 55%, rgba(0,0,0,0.28) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Intro title card (0–2.4s). */}
      <Sequence durationInFrames={Math.round(2.4 * fps)} name="Intro">
        <IntroCard />
      </Sequence>

      {/* Persistent brand mark, bottom-left. */}
      <BrandMark />

      {/* Chapter lower-thirds. */}
      {CHAPTERS.map((c) => {
        const from = Math.round(c.fromSec * fps);
        const dur = Math.round((c.toSec - c.fromSec) * fps);
        return (
          <Sequence key={c.index} from={from} durationInFrames={dur} name={`Ch ${c.index}`}>
            <ChapterLowerThird chapter={c} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/* ── Intro card ─────────────────────────────────────────────────────────── */

const IntroCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  // Fade out over the last 12 frames of the sequence.
  const exit = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(enter, [0, 1], [24, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: "rgba(5,5,5,0.72)",
        opacity: exit,
      }}
    >
      <div style={{ transform: `translateY(${y}px)`, textAlign: "center", opacity: enter }}>
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: 20,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: ACCENT,
            marginBottom: 20,
          }}
        >
          ● meeting assistant · recall.ai
        </div>
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: 92,
            fontWeight: 700,
            color: "#fafafa",
            letterSpacing: -2,
          }}
        >
          Casper Agent
        </div>
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: 26,
            color: "#a1a1aa",
            marginTop: 18,
          }}
        >
          A real session — the meeting notebook, team dynamics, and minutes by email.
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ── Chapter lower-third ────────────────────────────────────────────────── */

const ChapterLowerThird: React.FC<{ chapter: Chapter }> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const exit = interpolate(frame, [durationInFrames - 14, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(enter, [0, 1], [-40, 0]);
  const opacity = Math.min(enter, exit);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start" }}>
      <div
        style={{
          transform: `translateX(${x}px)`,
          opacity,
          margin: "0 0 72px 72px",
          padding: "18px 26px",
          borderRadius: 10,
          background: "rgba(9,9,11,0.86)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderLeft: `3px solid ${ACCENT}`,
          backdropFilter: "blur(6px)",
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: 40,
            fontWeight: 700,
            color: ACCENT,
            lineHeight: 1,
          }}
        >
          {chapter.index}
        </div>
        <div>
          <div
            style={{
              fontFamily: FONT_STACK,
              fontSize: 32,
              fontWeight: 600,
              color: "#fafafa",
            }}
          >
            {chapter.title}
          </div>
          <div
            style={{
              fontFamily: FONT_STACK,
              fontSize: 18,
              color: "#71717a",
              marginTop: 4,
            }}
          >
            {chapter.sub}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ── Brand mark ─────────────────────────────────────────────────────────── */

const BrandMark: React.FC = () => {
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-end" }}>
      <div
        style={{
          margin: "36px 44px 0 0",
          fontFamily: FONT_STACK,
          fontSize: 16,
          letterSpacing: 3,
          textTransform: "uppercase",
          color: "rgba(250,250,250,0.55)",
        }}
      >
        casper<span style={{ color: ACCENT }}>.</span>agent
      </div>
    </AbsoluteFill>
  );
};
