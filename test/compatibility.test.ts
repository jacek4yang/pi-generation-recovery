import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
import { OWNER } from "../src/state.js";
import { harness } from "./harness.js";
const jiti = createJiti(import.meta.url);
const codebuffer = (await jiti.import("pi-codebuffer/index.ts", {
  default: true,
})) as ExtensionFactory;
const { createExtension } = (await jiti.import(
  "pi-codex-native-compaction",
)) as { createExtension: (config: object) => ExtensionFactory };

for (const buffers of [false, true])
  for (const native of [false, true])
    for (const reverse of [false, true])
      test(
        "three-plugin SDK matrix buffer=" +
          buffers +
          " native=" +
          native +
          " reverse=" +
          reverse,
        async () => {
          const metrics = newMetrics();
          let root = "";
          const recovery: ExtensionFactory = (pi) =>
            generationRecovery({ root, metrics })(pi);
          const nativeFactory = createExtension({
            softThresholdRatio: 0.00000001,
          });
          const factories = [
            recovery,
            ...(buffers ? [codebuffer] : []),
            ...(native ? [nativeFactory] : []),
          ];
          if (reverse) factories.reverse();
          let pendingObserved = false;
          factories.push((pi) => {
            pi.on("turn_end", (e) => {
              if (
                e.message.role === "assistant" &&
                e.message.stopReason === "error"
              )
                pendingObserved = e.context.pendingMessages.some(
                  (m) => m.role === "custom" && m.customType === OWNER,
                );
            });
          });
          const h = await harness({ factories });
          root = join(h.dir, "journals");
          try {
            const s = await h.make();
            // Establish a native checkpoint before the recovery, and a tool result head when CodeBuffer is installed.
            h.scripts.push({ text: "healthy baseline" });
            await s.prompt("baseline");
            if (native)
              assert(
                s.sessionManager
                  .getBranch()
                  .some((e) => e.type === "compaction"),
              );
            const before = JSON.stringify(
              s.sessionManager
                .getBranch()
                .filter((e) => e.type === "compaction"),
            );
            if (buffers)
              h.scripts.push({
                tool: {
                  name: "codebuffer",
                  args: JSON.stringify({
                    action: "create",
                    name: "durable",
                    source: "text(42);",
                  }),
                },
              });
            // Failure follows the canonical tool result (or its native checkpoint), never precedes it.
            h.scripts.push(
              {
                reasoning: "complete",
                text: "preserved prefix ".repeat(350),
                fail: true,
              },
              { text: "continuation conclusion" },
            );
            let executions = 0;
            const toolErrors: unknown[] = [];
            s.subscribe((e) => {
              if (
                e.type === "tool_execution_start" &&
                e.toolName === "codebuffer"
              )
                executions++;
              if (
                e.type === "tool_execution_end" &&
                e.toolName === "codebuffer" &&
                e.isError
              )
                toolErrors.push(e.result);
            });
            await s.prompt("recover fixture");
            assert.deepEqual(
              toolErrors,
              [],
              "Actual CodeBuffer operation must succeed",
            );
            assert.equal(executions, buffers ? 1 : 0);
            assert.equal(
              metrics.stateResumeSuccesses,
              1,
              JSON.stringify({
                metrics,
                entries: s.sessionManager.getBranch().map((e) => ({
                  type: e.type,
                  ...(e.type === "custom"
                    ? {
                        owner: e.customType,
                        state: (e.data as { state?: string }).state,
                      }
                    : {}),
                })),
              }),
            );
            assert(pendingObserved);
            const entries = s.sessionManager.getBranch();
            if (native) {
              const old = JSON.parse(before) as { id: string }[];
              assert.equal(
                JSON.stringify(
                  entries.filter((e) => old.some((x) => x.id === e.id)),
                ),
                before,
              );
              assert(
                entries.filter((e) => e.type === "compaction").length >
                  old.length,
                JSON.stringify({
                  requests: h.payloads.map((p) =>
                    (p.input as { type?: string }[]).some(
                      (i) => i.type === "compaction_trigger",
                    ),
                  ),
                  entries: entries.map((e) => e.type),
                }),
              );
            }
            assert(
              !s.messages.some(
                (m) => m.role === "custom" && m.customType === OWNER,
              ),
            );
            const normal = h.payloads.filter(
              (p) =>
                !(p.input as { type?: string }[]).some(
                  (i) => i.type === "compaction_trigger",
                ),
            );
            const resumed = normal.find((p) =>
              JSON.stringify(p.input).includes("do not regenerate"),
            );
            assert(resumed);
            if (buffers)
              assert(
                JSON.stringify(resumed.input).includes(
                  native ? "compaction" : "function_call_output",
                ),
              );
            // Native compaction is allowed only AFTER the recovered canonical assistant is persisted.
            if (native) {
              const calls = h.payloads.filter((p) =>
                (p.input as { type?: string }[]).some(
                  (i) => i.type === "compaction_trigger",
                ),
              );
              const final = JSON.stringify(calls.at(-1)!.input);
              assert(final.includes("continuation conclusion"));
              assert(!final.includes("do not regenerate"));
            }
            const bufferState = entries.filter(
              (e) => e.type === "custom" && e.customType === "pi-codebuffer.v1",
            );
            if (buffers)
              assert(
                bufferState.length > 0,
                "A real durable CodeBuffer revision must exist",
              );
            const bufferEntries = JSON.stringify(bufferState);
            const sessionFile = s.sessionManager.getSessionFile()!;
            s.dispose();
            const reopened = await h.make(SessionManager.open(sessionFile));
            assert.equal(
              JSON.stringify(
                reopened.sessionManager
                  .getBranch()
                  .filter(
                    (e) =>
                      e.type === "custom" &&
                      e.customType === "pi-codebuffer.v1",
                  ),
              ),
              bufferEntries,
            );
            if (buffers)
              h.scripts.push({
                tool: {
                  name: "codebuffer",
                  args: JSON.stringify({ action: "read", name: "durable" }),
                },
              });
            h.scripts.push({ text: "reopened" });
            await reopened.prompt("reopen fixture");
            assert(
              !JSON.stringify(h.payloads.at(-1)!.input).includes(
                "do not regenerate",
              ),
            );
          } finally {
            await h.close();
          }
        },
      );
