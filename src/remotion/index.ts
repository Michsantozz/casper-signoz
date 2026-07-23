// Remotion entry point. Registers the root component that declares all
// compositions. This is intentionally OUTSIDE the FSD layers (features/mastra/
// server/shared) — it's a standalone video-rendering surface driven by the
// Remotion CLI/studio, not part of the Next app's import graph.
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
