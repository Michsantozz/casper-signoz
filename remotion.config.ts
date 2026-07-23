// Remotion CLI/studio configuration. Only affects `remotion studio` and
// `remotion render` — it is NOT part of the Next.js build.
//
// Docs: https://www.remotion.dev/docs/config
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("./src/remotion/index.ts");
// H.264 MP4 output by default; the recorded footage is already H.264.
Config.setCodec("h264");
// The composition draws over real UI footage — overwrite is convenient locally.
Config.setOverwriteOutput(true);
