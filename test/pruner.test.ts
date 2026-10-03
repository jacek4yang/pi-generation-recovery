import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
import { harness } from "./harness.js";
const configRoot = await mkdtemp(join(tmpdir(), "pruner-test-"));
const oldAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = configRoot;
await mkdir(join(configRoot, "context-prune"));
const config = async (mode: string) =>
  writeFile(
    join(configRoot, "context-prune", "settings.json"),
    JSON.stringify({
      enabled: true,
      pruneOn: mode,
      summarizerModel: "default",
      showStartupNotice: false,
      showPruneStatusLine: false,
      remindUnprunedCount: true,
    }),
  );
await config("agentic-auto");
const jiti = createJiti(import.meta.url);
const pruner = (await jiti.import("pi-context-prune", {
  default: true,
})) as ExtensionFactory;
const buffer = (await jiti.import("pi-codebuffer", {
  default: true,
})) as ExtensionFactory;
const { createExtension } = (await jiti.import(
  join(
    import.meta.dirname,
    "../node_modules/pi-codex-native-compaction/src/index.ts",
  ),
)) as { createExtension: (c: object) => ExtensionFactory };
after(async () => {
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgent;
  await rm(configRoot, { recursive: true, force: true });
});
for (const order of [
  [0, 1, 2, 3],
  [3, 2, 1, 0],
  [1, 0, 3, 2],
  [2, 3, 0, 1],
])
  test("actual four-plugin pruning SDK order " + order.join(","), async () => {
    await config("agentic-auto");
    const metrics = newMetrics();
    let root = "";
    const factories: ExtensionFactory[] = [
      (pi) => generationRecovery({ root, metrics })(pi),
      buffer,
      createExtension({}),
      pruner,
    ];
    const h = await harness({ factories: order.map((i) => factories[i]!) });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      let sideEffects = 0;
      let toolErrors = 0;
      s.subscribe((e) => {
        if (e.type === "tool_execution_end") {
          if (e.isError) toolErrors++;
          if (e.toolName === "codebuffer") sideEffects++;
        }
      });
      h.scripts.push(
        {
          tool: {
            name: "codebuffer",
            args: JSON.stringify({
              action: "create",
              name: "persistent",
              source: "text(" + JSON.stringify("x".repeat(3000)) + ");",
            }),
          },
        },
        {
          tool: {
            name: "codebuffer",
            args: JSON.stringify({
              action: "run",
              name: "persistent",
              revision: 1,
            }),
          },
        },
        { tool: { name: "context_prune", args: "{}" } },
        { text: "pruned baseline" },
      );
      await s.prompt("synthetic fixture");
      assert.equal(toolErrors, 0);
      assert.equal(sideEffects, 2);
      const owned = () =>
        s.sessionManager
          .getBranch()
          .filter(
            (e) =>
              (e.type === "custom" &&
                e.customType !== "pi-generation-recovery.v1") ||
              e.type === "custom_message",
          );
      const before = owned();
      assert(
        before.some(
          (e) => e.type === "custom" && e.customType === "context-prune-index",
        ),
      );
      assert(
        before.some(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "context-prune-summary",
        ),
      );
      await s.compact();
      h.scripts.push(
        {
          reasoning: "complete",
          text: "committed prefix ".repeat(350),
          fail: true,
        },
        { text: "recovered conclusion" },
      );
      await s.prompt("interrupted inference fixture");
      assert.equal(metrics.stateResumeSuccesses, 1);
      assert.equal(sideEffects, 2);
      for (const entry of before)
        assert.deepEqual(
          s.sessionManager.getBranch().find((e) => e.id === entry.id),
          entry,
        );
      await s.compact();
      const file = s.sessionManager.getSessionFile()!;
      const requests = h.payloads.length;
      s.dispose();
      const reopened = await h.make(SessionManager.open(file));
      assert.equal(h.payloads.length, requests);
      h.scripts.push(
        {
          tool: {
            name: "codebuffer",
            args: JSON.stringify({ action: "read", name: "persistent" }),
          },
        },
        { text: "ordinary subsequent turn" },
      );
      await reopened.prompt("reopen read fixture");
      assert(
        !JSON.stringify(h.payloads.at(-1)?.input)
          .toLowerCase()
          .includes("do not regenerate"),
      );
      assert(
        !reopened.messages.some(
          (m) =>
            m.role === "user" &&
            JSON.stringify(m.content)
              .toLowerCase()
              .includes("do not regenerate"),
        ),
      );
      assert(h.payloads.length < 16);
    } finally {
      await h.close();
    }
  });
for (const reverse of [false, true])
  test(
    "pruning during failed generation invalidates checkpoint order=" + reverse,
    async () => {
      await config("agent-message");
      const metrics = newMetrics();
      let root = "";
      const recovery: ExtensionFactory = (pi) =>
        generationRecovery({ root, metrics })(pi);
      const factories = [recovery, buffer, pruner];
      if (reverse) factories.reverse();
      const h = await harness({ factories });
      root = join(h.dir, "journals");
      try {
        const s = await h.make();
        h.scripts.push(
          {
            tool: {
              name: "codebuffer",
              args: JSON.stringify({
                action: "create",
                name: "pending",
                source: "text(1);",
              }),
            },
          },
          {
            tool: {
              name: "codebuffer",
              args: JSON.stringify({ action: "read", name: "pending" }),
            },
          },
          { reasoning: "complete", text: "prefix ".repeat(700), fail: true },
          { text: "safe full retry" },
        );
        await s.prompt("pending prune");
        assert.equal(metrics.stateResumeSuccesses, 0);
        assert(metrics.staleCheckpointsRejected > 0);
        assert(
          s.sessionManager
            .getBranch()
            .some(
              (e) =>
                e.type === "custom" &&
                e.customType === "context-prune-frontier",
            ),
        );
        assert(
          !h.payloads.some((p) =>
            JSON.stringify(p.input).toLowerCase().includes("do not regenerate"),
          ),
        );
      } finally {
        await h.close();
      }
    },
  );
