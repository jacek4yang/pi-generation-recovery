import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
import { OWNER } from "../src/state.js";
import { harness } from "./harness.js";

for (const retry of [false, true])
  test("actual Pi-authorized state resume, retry=" + retry, async () => {
    const metrics = newMetrics();
    let root = "";
    const h = await harness({
      retry,
      factories: [(pi) => generationRecovery({ root, metrics })(pi)],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      const prefix = "## Answer\n" + "committed unique text 🧪\n".repeat(200);
      const suffix = "remaining conclusion";
      h.scripts.push(
        { reasoning: "complete", text: prefix, fail: true },
        { text: suffix },
      );
      await s.prompt("fixture");
      assert.equal(h.payloads.length, retry ? 2 : 1);
      assert.equal(metrics.stateResumeSuccesses, retry ? 1 : 0);
      if (retry) {
        const retryInput = JSON.stringify(h.payloads[1]!.input);
        assert(retryInput.includes("opaque-fixture-not-real"));
        assert(retryInput.includes("committed unique text"));
        assert(retryInput.includes("do not regenerate"));
        const a = s.messages.filter((m) => m.role === "assistant").at(-1)!;
        assert.equal(
          a.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
          prefix + suffix,
        );
        assert(
          !s.messages.some(
            (m) => m.role === "custom" && m.customType === OWNER,
          ),
        );
        h.scripts.push({ text: "next turn" });
        await s.prompt("next");
        const nextInput = JSON.stringify(h.payloads[2]!.input);
        assert(!nextInput.includes("do not regenerate"));
        assert(nextInput.includes(suffix));
      }
    } finally {
      await h.close();
    }
  });
