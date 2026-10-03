// Opt-in live fault injection, bounded independently of Pi's retry owner.
// Only aggregate counters leave this process; opaque items and arguments never do.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import {
  ModelRuntime,
  SettingsManager,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
if (process.env.PI_GENERATION_RECOVERY_LIVE !== "1")
  throw Error("Opt-in required");
const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6-astra");
assert(model?.api === "openai-codex-responses");
assert.equal((await runtime.checkAuth("openai-codex"))?.type, "oauth");
const root = await mkdtemp(join(tmpdir(), "recovery-prefix-live-"));
const sessions: AgentSession[] = [];
const metrics = newMetrics();
const originalFetch = globalThis.fetch;
const deadline = Date.now() + 360000;
let requests = 0,
  cuts = 0,
  toolsExecuted = 0,
  replayedRequests = 0,
  verifiedItems = 0,
  observedComplete = 0,
  mode = "reasoning",
  remaining = 0,
  observedSignature = false;
const droppedIds = new Set<string>();
const expected = new Set<string>();
const inheritedSafe = new Set<string>();
const probes: object[] = [];
const events: Record<string, number> = {};
const reasoningOptions: unknown[] = [];
const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function inputOf(init?: RequestInit): Record<string, unknown>[] {
  if (!init?.body) return [];
  const body = init.body;
  let buffer: Buffer;
  if (typeof body === "string") buffer = Buffer.from(body);
  else if (body instanceof Uint8Array) buffer = Buffer.from(body);
  else if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
  else throw Error("Unsupported test request body");
  if (new Headers(init.headers).get("content-encoding") === "zstd")
    buffer = zstdDecompressSync(buffer);
  const request = JSON.parse(buffer.toString()) as {
    input?: Record<string, unknown>[];
    reasoning?: unknown;
  };
  reasoningOptions.push(request.reasoning ?? null);
  return request.input ?? [];
}
globalThis.fetch = async (input, init) => {
  assert(++requests <= 10, "Live request budget exhausted");
  assert(Date.now() < deadline, "Live time budget exhausted");
  const items = inputOf(init);
  for (const item of items) {
    assert(!droppedIds.has(String(item.id)), "Discarded item replayed");
  }
  if (expected.size) {
    const replayed = new Set(
      items.filter((i) => i.type === "reasoning").map(digest),
    );
    for (const h of expected)
      assert(
        replayed.has(h),
        "Safe signed prefix absent in live retry request",
      );
    verifiedItems += expected.size;
    replayedRequests++;
    expected.clear();
  }
  const response = await originalFetch(input, {
    ...init,
    signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]),
  });
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  let buffer = "",
    shouldCut = false,
    completed = false;
  let currentTool: string | undefined;
  const signed = new Set<string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let emitted = 0;
  observedSignature = false;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (shouldCut && !observedSignature && !inheritedSafe.size)
            await new Promise((r) => setTimeout(r, 1));
          if (shouldCut && (observedSignature || inheritedSafe.size > 0)) {
            cuts++;
            remaining--;
            for (const h of signed) inheritedSafe.add(h);
            for (const h of inheritedSafe) expected.add(h);
            if (currentTool) droppedIds.add(currentTool);
            controller.error(
              new TypeError(
                "network error: controlled safe-frontier interruption",
              ),
            );
            await reader.cancel().catch(() => {});
            return;
          }
          while (true) {
            buffer = buffer.replaceAll("\r\n", "\n");
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
              const record = buffer.slice(0, end + 2);
              buffer = buffer.slice(end + 2);
              for (const line of record.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                let event: {
                  type?: string;
                  delta?: unknown;
                  item?: {
                    type?: string;
                    id?: string;
                    encrypted_content?: string;
                    [key: string]: unknown;
                  };
                };
                try {
                  event = JSON.parse(line.slice(6));
                } catch {
                  continue;
                }
                if (typeof event.type === "string")
                  events[event.type] = (events[event.type] ?? 0) + 1;
                if (
                  event.type === "response.output_item.done" &&
                  event.item?.type === "reasoning" &&
                  event.item.encrypted_content
                ) {
                  signed.add(digest(event.item));
                  completed = true;
                  observedComplete++;
                  if (remaining > 0 && mode === "reasoning") shouldCut = true;
                }
                if (
                  event.type === "response.output_item.added" &&
                  event.item?.type === "function_call"
                )
                  currentTool = event.item.id;
                if (
                  remaining > 0 &&
                  (completed || inheritedSafe.size > 0) &&
                  ((mode === "tool" &&
                    event.type === "response.function_call_arguments.delta") ||
                    (mode === "later-reasoning" &&
                      event.type === "response.reasoning_summary_text.delta"))
                )
                  shouldCut = true;
                if (typeof event.delta === "string") {
                  emitted += event.delta.length;
                  assert(emitted <= 12000, "Live output budget exhausted");
                }
              }
              controller.enqueue(encoder.encode(record));
              return;
            }
            const next = await reader.read();
            if (next.done) {
              if (buffer) controller.enqueue(encoder.encode(buffer));
              controller.close();
              return;
            }
            buffer += decoder.decode(next.value, { stream: true });
            assert(buffer.length <= 1048576, "SSE fixture bound exceeded");
          }
        },
        async cancel() {
          await reader.cancel();
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
};
const timeout = setTimeout(() => {
  for (const s of sessions) void s.abort();
}, 360000);
try {
  for (const [kind, requestedCuts] of [
    ["reasoning", 1],
    ["tool", 2],
    ["later-reasoning", 1],
  ] as const) {
    if (
      process.env.PI_LIVE_PREFIX_CASE &&
      process.env.PI_LIVE_PREFIX_CASE !== kind
    )
      continue;
    mode = kind;
    remaining = requestedCuts;
    expected.clear();
    inheritedSafe.clear();
    const before = { cuts, requests, advanced: metrics.stateResumeSuccesses };
    const settings = SettingsManager.inMemory({
      transport: "sse",
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 1000,
        provider: { maxRetries: 0 },
      },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPrompt:
        "Isolated coding review fixture. Use only report_result. No filesystem, shell or network tools. Keep final output under 120 words.",
      extensionFactories: [
        generationRecovery({ root: join(root, "journals"), metrics }),
        (pi) => {
          pi.registerTool({
            name: "report_result",
            label: "report_result",
            description: "Record a small coding review result in memory only.",
            parameters: Type.Object({
              summary: Type.String({ maxLength: 600 }),
            }),
            async execute() {
              toolsExecuted++;
              return {
                content: [{ type: "text", text: "recorded" }],
                details: {},
              };
            },
          });
          pi.on("message_start", () => {
            observedSignature = false;
          });
          pi.on("message_update", (e) => {
            if (e.assistantMessageEvent.type === "thinking_end")
              observedSignature = true;
          });
          pi.on("tool_call", (e) => {
            if (e.toolName !== "report_result")
              return { block: true, reason: "Fixture blocks external actions" };
          });
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model,
      thinkingLevel: "medium",
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    sessions.push(session);
    await session.bindExtensions({
      onError: () => {
        throw Error("Live extension error (details suppressed)");
      },
    });
    session.setActiveToolsByName(["report_result"]);
    await session.prompt(
      "Review a bounded lock-free MPMC ring buffer algorithm under C++ acquire/release semantics. Capacity N is a power of two. Atomics head and tail are monotonically increasing uint64 counters; slots contain non-atomic optional<T>. enqueue reads tail relaxed, reads head acquire, rejects if tail-head==N, CAS tail from t to t+1 with acq_rel, then writes slots[t%N]=value. dequeue reads head relaxed, reads tail acquire, rejects if equal, CAS head from h to h+1 with acq_rel, then reads and clears slots[h%N]. Both retry on CAS failure. The author says acq_rel plus unique counter reservations prove linearizability and safe slot reuse. Determine whether this is correct even ignoring integer wraparound. Check producer publication, consumer reclamation, overlapping reservations, stalled producers, and progress of a per-slot sequence-number repair. Give two distinct minimal interleavings with actors and counter/slot values, then a corrected protocol and an honest progress guarantee. Do not inspect files or use external tools. Call report_result once with a concise verdict and the essential counterexamples (under 600 characters), then finish in at most 100 words.",
    );
    const last = session.messages.filter((m) => m.role === "assistant").at(-1);
    assert.equal(
      last?.stopReason,
      "stop",
      "Live request did not finish (payload suppressed)",
    );
    assert(last.content.some((c) => c.type === "text" && c.text.length > 0));
    if (process.env.PI_LIVE_REVIEW_TEXT === "1")
      console.log(
        JSON.stringify({
          fixtureFinalText: last.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
        }),
      );
    const actual = cuts - before.cuts;
    probes.push({
      kind,
      requestedCuts,
      actualCuts: actual,
      requests: requests - before.requests,
      statePreservingSuccesses: metrics.stateResumeSuccesses - before.advanced,
      finished: true,
    });
    console.log(JSON.stringify(probes.at(-1)));
    if (kind !== "later-reasoning") {
      assert(actual > 0, "Requested live frontier was not observed");
      assert(
        metrics.stateResumeSuccesses > before.advanced,
        "Live interruption did not recover state",
      );
    }
  }
  assert.equal(expected.size, 0);
  assert.equal(metrics.fullRetryFallbacks, 0);
  assert.equal(metrics.stateResumeAttempts, cuts);
  assert(replayedRequests >= cuts);
} finally {
  clearTimeout(timeout);
  globalThis.fetch = originalFetch;
  for (const s of sessions) s.dispose();
  const report = {
    events,
    reasoningOptions,
    model: model.id,
    thinking: "medium",
    transport: "sse",
    requests,
    controlledInterruptions: cuts,
    naturalInterruptions: Math.max(0, metrics.interruptedGenerations - cuts),
    replayedRequests,
    verifiedItems,
    observedComplete,
    toolsExecuted,
    probes,
    metrics,
  };
  await writeFile(
    process.argv[2] ?? "/tmp/generation-live-prefix.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      requests,
      cuts,
      replayedRequests,
      verifiedItems,
      advanced: metrics.stateResumeAttempts,
      fallbacks: metrics.fullRetryFallbacks,
    }),
  );
  await rm(root, { recursive: true, force: true });
}
