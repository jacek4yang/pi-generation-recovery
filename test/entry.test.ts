import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { harness } from "./harness.js";
import { OWNER } from "../src/state.js";
test("public source entry loads through Pi's actual extension loader", async () => {
  const entry = existsSync("index.ts")
    ? resolve("index.ts")
    : resolve("node_modules/pi-generation-recovery/index.ts");
  const h = await harness({ extensions: [entry] });
  const previous = process.env.PI_GENERATION_RECOVERY_DIR;
  process.env.PI_GENERATION_RECOVERY_DIR = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push(
      { reasoning: "complete", text: "entry prefix", fail: true },
      { text: "entry suffix" },
    );
    await s.prompt("fixture");
    assert(
      s.sessionManager
        .getBranch()
        .some(
          (e) =>
            e.type === "custom" &&
            e.customType === OWNER &&
            (e.data as { state: string }).state === "canonicalized",
        ),
    );
    assert.equal(h.payloads.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PI_GENERATION_RECOVERY_DIR;
    else process.env.PI_GENERATION_RECOVERY_DIR = previous;
    await h.close();
  }
});
