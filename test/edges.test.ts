import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
import {
  exactOverlap,
  hasHeadroom,
  matchesIdentity,
  type Identity,
} from "../src/state.js";
import { harness } from "./harness.js";

test("bounded repeated state resume preserves the entire prefix chain", async () => {
  const metrics = newMetrics();
  let root = "";
  const h = await harness({
    maxRetries: 2,
    factories: [(pi) => generationRecovery({ root, metrics })(pi)],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push(
      { reasoning: "complete", text: "first ", fail: true },
      { text: "second ", fail: true },
      { text: "third" },
    );
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 3);
    assert.equal(metrics.reasoningStateReplayed, 2);
    assert.equal(metrics.stateResumeSuccesses, 1);
    const a = s.messages.filter((m) => m.role === "assistant").at(-1)!;
    assert.equal(
      a.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
      "first second third",
    );
    assert(JSON.stringify(h.payloads[2]!.input).includes("second"));
  } finally {
    await h.close();
  }
});

test("pure-text Codex semantic recovery, not invented reasoning state", async () => {
  const metrics = newMetrics();
  let root = "";
  const h = await harness({
    reasoning: false,
    factories: [(pi) => generationRecovery({ root, metrics })(pi)],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push(
      { text: "pure text ".repeat(500), fail: true },
      { text: "done" },
    );
    await s.prompt("fixture");
    assert.equal(metrics.semanticResumeSuccesses, 1);
    assert.equal(metrics.reasoningStateReplayed, 0);
  } finally {
    await h.close();
  }
});

for (const mutation of ["tools", "model", "thinking", "branch"] as const)
  test("reject stale recovery after " + mutation, async () => {
    const metrics = newMetrics();
    let root = "";
    let branch: () => void = () => {};
    const mutate: ExtensionFactory = (pi) => {
      let contexts = 0;
      pi.on("context", () => {
        if (mutation === "branch" && ++contexts === 2) branch();
      });
      pi.on("turn_end", async (e, ctx) => {
        if (e.message.role !== "assistant" || e.message.stopReason !== "error")
          return;
        if (mutation === "tools") pi.setActiveTools([]);
        if (mutation === "model")
          await pi.setModel({ ...ctx.model!, id: "fixture-other-model" });
        if (mutation === "thinking") pi.setThinkingLevel("high");
      });
    };
    const recovery: ExtensionFactory = (pi) =>
      generationRecovery({ root, metrics })(pi);
    const h = await harness({
      factories:
        mutation === "branch" ? [mutate, recovery] : [recovery, mutate],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      branch = () => {
        s.sessionManager.branch(
          s.sessionManager
            .getBranch()
            .find((e) => e.type === "message" && e.message.role === "user")!.id,
        );
      };
      h.scripts.push(
        { reasoning: "complete", text: "prefix", fail: true },
        { text: "plain retry" },
      );
      await s.prompt("fixture");
      assert.equal(metrics.stateResumeSuccesses, 0);
      assert(
        !JSON.stringify(h.payloads[1]!.input).includes("do not regenerate"),
      );
      assert(metrics.staleCheckpointsRejected > 0);
    } finally {
      await h.close();
    }
  });

test("unsafe context headroom falls back without a pending recovery/compaction cycle", async () => {
  const metrics = newMetrics();
  let root = "";
  const h = await harness({
    contextWindow: 4096,
    factories: [(pi) => generationRecovery({ root, metrics })(pi)],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push(
      { reasoning: "complete", text: "prefix", fail: true },
      { text: "normal retry" },
    );
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 2);
    assert.equal(metrics.replayedInputBytes, 0);
    assert(!JSON.stringify(h.payloads[1]!.input).includes("opaque-fixture"));
  } finally {
    await h.close();
  }
});

test("journal failure never interrupts Pi or replays uncommitted state", async () => {
  const metrics = newMetrics();
  let root = "";
  const h = await harness({
    factories: [(pi) => generationRecovery({ root, metrics })(pi)],
  });
  root = join(h.dir, "not-a-directory");
  await writeFile(root, "fixture");
  try {
    const s = await h.make();
    h.scripts.push(
      { reasoning: "complete", text: "prefix", fail: true },
      { text: "normal retry" },
    );
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 2);
    assert.equal(metrics.replayedInputBytes, 0);
    assert(metrics.journalFailures >= 1);
  } finally {
    await h.close();
  }
});

test(
  "user abort is captured, never automatically continued",
  { timeout: 10000 },
  async () => {
    const metrics = newMetrics();
    let root = "";
    const h = await harness({
      factories: [(pi) => generationRecovery({ root, metrics })(pi)],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      let aborted = false;
      s.subscribe((e) => {
        if (e.type === "message_update" && !aborted) {
          aborted = true;
          void s.abort();
        }
      });
      h.scripts.push({
        reasoning: "complete",
        text: "prefix",
        fail: true,
        hold: true,
      });
      await s.prompt("fixture");
      assert(aborted);
      assert.equal(h.payloads.length, 1);
      assert.equal(metrics.stateResumeSuccesses, 0);
      assert.equal(
        s.messages.filter((m) => m.role === "assistant").at(-1)?.stopReason,
        "aborted",
      );
    } finally {
      await h.close();
    }
  },
);

for (const script of [
  { reasoning: "partial" as const, fail: true },
  {
    reasoning: "complete" as const,
    tool: { name: "codebuffer", args: '{"action":', partial: true },
    fail: true,
  },
  {
    reasoning: "complete" as const,
    text: "prefix",
    terminalError: "Invalid request parameter",
  },
])
  test(
    "unsafe actions never replay; safe state needs Pi retry: " +
      JSON.stringify(script),
    async () => {
      const metrics = newMetrics();
      let root = "";
      const h = await harness({
        factories: [(pi) => generationRecovery({ root, metrics })(pi)],
      });
      root = join(h.dir, "journals");
      try {
        const s = await h.make();
        let executions = 0;
        s.subscribe((e) => {
          if (e.type === "tool_execution_start") executions++;
        });
        h.scripts.push(script, { text: "normal retry" });
        await s.prompt("fixture");
        assert.equal(executions, 0);
        if ("tool" in script) {
          assert.equal(metrics.stateResumeSuccesses, 1);
          assert.equal(metrics.partialToolCallsDropped, 1);
          const input = h.payloads[1]!.input as { type?: string }[];
          assert.equal(input.filter((i) => i.type === "reasoning").length, 1);
          assert(!input.some((i) => i.type === "function_call"));
          assert(!JSON.stringify(input).includes('{\\"action\\":'));
        } else assert.equal(metrics.replayedInputBytes, 0);
        assert.equal(h.payloads.length, "terminalError" in script ? 1 : 2);
      } finally {
        await h.close();
      }
    },
  );

test("reopen interrupted checkpoint does not resurrect an unauthorized retry", async () => {
  const metrics = newMetrics();
  let root = "";
  const h = await harness({
    retry: false,
    factories: [(pi) => generationRecovery({ root, metrics })(pi)],
  });
  root = join(h.dir, "journals");
  try {
    const s = await h.make();
    h.scripts.push({ reasoning: "complete", text: "prefix", fail: true });
    await s.prompt("fixture");
    const file = s.sessionManager.getSessionFile()!;
    s.dispose();
    const reopened = await h.make(SessionManager.open(file));
    h.scripts.push({ text: "new user turn" });
    await reopened.prompt("new fixture");
    assert.equal(metrics.replayedInputBytes, 0);
    assert(!JSON.stringify(h.payloads[1]!.input).includes("do not regenerate"));
  } finally {
    await h.close();
  }
});

test("exact overlap and identity guards never use semantic similarity", () => {
  assert.equal(exactOverlap("foo alpha", "alpha beta"), 0);
  assert.equal(
    exactOverlap(
      "prefix:" + "unique long exact overlap text here",
      "unique long exact overlap text here plus",
    ),
    "unique long exact overlap text here".length,
  );
  assert.equal(exactOverlap("One sentence.", "one sentence."), 0);
  assert.equal(exactOverlap("🧪foo", "🧪foo suffix"), 0);
  assert.equal(exactOverlap("123456", "123456", 3), 0);
  assert(!hasHeadroom(1, undefined, 100, 10));
  assert(!hasHeadroom(90, 1, 100, 10));
  const a: Identity = {
    session: "s",
    head: "h",
    source: "u",
    turn: 1,
    provider: "p",
    api: "a",
    model: "m",
    thinking: "high",
    systemHash: "system",
    toolsHash: "tools",
  };
  for (const k of Object.keys(a) as (keyof Identity)[])
    assert(!matchesIdentity(a, { ...a, [k]: String(a[k]) + "changed" }));
  assert(matchesIdentity(a, { ...a }));
});
