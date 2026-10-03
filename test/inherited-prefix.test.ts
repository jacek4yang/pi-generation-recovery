import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { harness, type Script } from "./harness.js";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
for (const tail of [
  { reasoning: "partial", fail: true },
  {
    tool: { name: "write", args: '{"path":"NEVER_REPLAY', partial: true },
    fail: true,
  },
  { fail: true },
] as Script[])
  test(
    "inherit safe state when retry contributes no completed state: " +
      JSON.stringify(tail),
    async () => {
      const metrics = newMetrics();
      let root = "";
      const h = await harness({
        maxRetries: 3,
        factories: [(pi) => generationRecovery({ root, metrics })(pi)],
      });
      root = join(h.dir, "journals");
      try {
        const s = await h.make();
        h.scripts.push({ reasoning: "complete", fail: true }, tail, {
          text: "finished",
        });
        await s.prompt("fixture");
        assert.equal(h.payloads.length, 3);
        const input = h.payloads[2]!.input as Record<string, unknown>[];
        assert.deepEqual(
          input.filter((i) => i.type === "reasoning").map((i) => i.id),
          ["rs_1_0"],
        );
        assert(!input.some((i) => i.type === "function_call"));
        assert(!JSON.stringify(input).includes("NEVER_REPLAY"));
        assert.equal(metrics.stateResumeAttempts, 2);
        assert.equal(metrics.stateResumeSuccesses, 1);
        assert.equal(metrics.recoverableSafePrefixes, 2);
        assert.equal(metrics.fullRetryFallbacks, 0);
      } finally {
        await h.close();
      }
    },
  );
