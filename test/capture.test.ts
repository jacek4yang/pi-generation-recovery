import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  reduceAssistantMessageFrames,
  type AssistantMessageFrame,
} from "@earendil-works/pi-ai";
import { captureExtension, newMetrics } from "../src/extension.js";
import { readJournal } from "../src/journal.js";
import { OWNER, type GenerationCheckpoint } from "../src/state.js";
import { harness, type Script } from "./harness.js";

for (const [name, script, frontier, candidate] of [
  [
    "healthy",
    { text: "Unicode 🧪 中文\n\n# Heading\n**bold**" },
    "TERMINAL_COMPLETE",
    "none",
  ],
  ["nothing", { fail: true }, "NOTHING_RECEIVED", "none"],
  [
    "partial reasoning",
    { reasoning: "partial", fail: true },
    "PARTIAL_REASONING",
    "none",
  ],
  [
    "completed reasoning and prefix",
    {
      reasoning: "complete",
      text: "## Answer\n" + "prefix 🧪 ".repeat(900),
      fail: true,
    },
    "PARTIAL_TEXT",
    "state-preserving",
  ],
  [
    "text on reasoning model",
    { text: "long prefix ".repeat(500), fail: true },
    "PARTIAL_TEXT",
    "none",
  ],
  [
    "partial tool",
    {
      tool: {
        name: "codebuffer",
        args: '{"action":"create","source":"partial',
        partial: true,
      },
      fail: true,
    },
    "PARTIAL_TOOL_CALL",
    "none",
  ],
] as const)
  test("capture actual Codex frames: " + name, async () => {
    const checkpoints: GenerationCheckpoint[] = [];
    const metrics = newMetrics();
    let root = "";
    const h = await harness({
      factories: [
        (pi) =>
          captureExtension({
            enabled: true,
            root,
            onCheckpoint: (cp) => checkpoints.push(cp),
            metrics,
          })(pi),
      ],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      let executions = 0;
      s.subscribe((e) => {
        if (e.type === "tool_execution_start") executions++;
      });
      h.scripts.push(script as Script, { text: "normal Pi retry" });
      await s.prompt("fixture");
      assert.equal(executions, 0);
      const cp = checkpoints[0]!;
      assert(cp);
      assert.equal(cp.state, script.fail ? "interrupted" : "complete");
      assert.equal(cp.frontier, frontier);
      assert.equal(cp.candidate, candidate);
      assert.equal(metrics.stateResumeSuccesses, 0);
      assert.equal(metrics.replayedInputBytes, 0);
      const records = await readJournal(join(root, cp.journal));
      assert.equal(records.at(-1)?.hash, cp.hash);
      const frames = records.flatMap((r) => {
        const d = r.data as { kind: string; frame?: AssistantMessageFrame };
        return d.kind === "frame" ? [d.frame!] : [];
      });
      assert.equal(frames.length, cp.frameCount);
      const reconstructed = reduceAssistantMessageFrames(frames);
      assert(reconstructed);
      if ("text" in script)
        assert.equal(
          reconstructed.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
          script.text,
        );
      if ("reasoning" in script) {
        const block = reconstructed.content.find((c) => c.type === "thinking");
        assert.equal(
          !!block?.thinkingSignature,
          script.reasoning === "complete",
        );
      }
      assert.equal(h.payloads.length, script.fail ? 2 : 1);
      assert.equal(
        s.sessionManager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === OWNER).length,
        checkpoints.length,
      );
      assert(!s.messages.some((m) => m.role === "custom"));
    } finally {
      await h.close();
    }
  });

test("repeated EOF bounded by Pi, not a hidden extension loop", async () => {
  const cps: GenerationCheckpoint[] = [];
  let root = "";
  const h = await harness({
    maxRetries: 2,
    factories: [
      (pi) =>
        captureExtension({
          enabled: true,
          root,
          onCheckpoint: (cp) => cps.push(cp),
        })(pi),
    ],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push(
      ...Array.from({ length: 8 }, () => ({ text: "prefix", fail: true })),
    );
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 3);
    assert.equal(cps.length, 3);
  } finally {
    await h.close();
  }
});

test("non-retryable error is captured and never continues", async () => {
  const cps: GenerationCheckpoint[] = [];
  let root = "";
  const h = await harness({
    factories: [
      (pi) =>
        captureExtension({
          enabled: true,
          root,
          onCheckpoint: (cp) => cps.push(cp),
        })(pi),
    ],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push({
      text: "prefix",
      terminalError: "Invalid request parameter",
    });
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 1);
    assert.equal(cps[0]?.state, "interrupted");
  } finally {
    await h.close();
  }
});
