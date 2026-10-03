import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertSupportedPi } from "./src/compatibility.js";
assertSupportedPi(VERSION);
import { captureExtension } from "./src/extension.js";
import { generationRecovery } from "./src/recovery.js";
const mode = process.env.PI_GENERATION_RECOVERY_MODE ?? "on";
const root = process.env.PI_GENERATION_RECOVERY_DIR;
export default mode === "shadow"
  ? captureExtension({ enabled: true, root })
  : generationRecovery({ enabled: mode === "on", root });
