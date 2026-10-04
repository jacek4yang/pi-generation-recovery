import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { harness, type Script } from "./harness.js";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";

for (const [name, script, count] of [
  ["one reasoning only", { reasoning: "complete", fail: true }, 1],
  [
    "multiple reasoning only",
    { reasoning: ["complete", "complete"], fail: true },
    2,
  ],
  [
    "partial later reasoning",
    { reasoning: ["complete", "complete", "partial"], fail: true },
    2,
  ],
  [
    "partial tool arguments",
    {
      reasoning: ["complete", "complete"],
      tool: { name: "write", args: '{"path":"DO_NOT_EXECUTE', partial: true },
      fail: true,
    },
    2,
  ],
  [
    "terminated socket during long tool arguments",
    {
      reasoning: ["complete", "complete"],
      tool: {
        name: "codebuffer",
        args: '{"code":"DO_NOT_EXECUTE' + "x".repeat(65536),
        partial: true,
      },
      fail: true,
      disconnect: true,
    },
    2,
  ],
  [
    "completed text then partial tool",
    {
      reasoning: "complete",
      text: "committed answer",
      textComplete: true,
      tool: { name: "write", args: '{"path":"DO_NOT_EXECUTE', partial: true },
      fail: true,
    },
    1,
  ],
] as [string, Script, number][]) {
  test("safe frontier: " + name, async () => {
    const metrics = newMetrics();
    let root = "";
    let toolCalls = 0;
    const h = await harness({
      factories: [
        (pi) => {
          generationRecovery({ root, metrics })(pi);
          pi.on("tool_call", () => {
            toolCalls++;
          });
        },
      ],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      h.scripts.push(script, { text: "coherent conclusion" });
      await s.prompt("fixture");
      assert.equal(h.payloads.length, 2);
      assert.equal(metrics.stateResumeAttempts, 1);
      assert.equal(metrics.stateResumeSuccesses, 1);
      const input = h.payloads[1]!.input as Record<string, unknown>[];
      const reasoning = input.filter((i) => i.type === "reasoning");
      assert.deepEqual(
        reasoning,
        Array.from({ length: count }, (_, i) => ({
          type: "reasoning",
          id: "rs_1_" + i,
          summary: [{ type: "summary_text", text: "fixture reasoning" }],
          encrypted_content: "opaque-fixture-not-real",
        })),
      );
      assert(!input.some((i) => i.type === "function_call"));
      assert(!JSON.stringify(input).includes("DO_NOT_EXECUTE"));
      assert.equal(toolCalls, 0);
      const last = s.messages.filter((m) => m.role === "assistant").at(-1)!;
      assert.equal(
        last.content.filter((c) => c.type === "thinking").length,
        count,
      );
      assert.equal(last.content.filter((c) => c.type === "toolCall").length, 0);
      if (script.textComplete)
        assert(JSON.stringify(input).includes("committed answer"));
    } finally {
      await h.close();
    }
  });
}
for (const tail of ["reasoning", "tool", "text"] as const)
  test("chained safe frontier: " + tail, async () => {
    const metrics = newMetrics();
    let root = "";
    const h = await harness({
      maxRetries: 3,
      factories: [(pi) => generationRecovery({ root, metrics })(pi)],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      h.scripts.push(
        { reasoning: "complete", fail: true },
        {
          reasoning:
            tail === "reasoning" ? ["complete", "partial"] : "complete",
          ...(tail === "tool"
            ? {
                tool: {
                  name: "write",
                  args: '{"path":"DROPPED',
                  partial: true,
                },
              }
            : tail === "text"
              ? { text: "safe text" }
              : {}),
          fail: true,
        },
        { text: "final" },
      );
      await s.prompt("fixture");
      assert.equal(h.payloads.length, 3);
      const input = h.payloads[2]!.input as Record<string, unknown>[];
      assert.deepEqual(
        input.filter((i) => i.type === "reasoning").map((i) => i.id),
        ["rs_1_0", "rs_2_0"],
      );
      assert(!JSON.stringify(input).includes("DROPPED"));
      assert(!input.some((i) => i.type === "function_call"));
      assert.equal(metrics.stateResumeAttempts, 2);
      assert.equal(metrics.stateResumeSuccesses, 1);
    } finally {
      await h.close();
    }
  });
