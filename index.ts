import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertRecoveryCapabilities } from "./src/compatibility.js";
import { captureExtension } from "./src/extension.js";
import { generationRecovery } from "./src/recovery.js";
const mode = process.env.PI_GENERATION_RECOVERY_MODE ?? "on";
const root = process.env.PI_GENERATION_RECOVERY_DIR;
export default function extension(pi: ExtensionAPI) {
  if (mode === "on" || mode === "shadow") assertRecoveryCapabilities(pi);
  const register =
    mode === "shadow"
      ? captureExtension({ enabled: true, root })
      : generationRecovery({ enabled: mode === "on", root });
  register(pi);
}
