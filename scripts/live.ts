// Opt-in, bounded live validation. No production session or raw payload is written here.
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { generationRecovery } from "../src/recovery.js";
import { newMetrics } from "../src/extension.js";
import { collectJournals, retentionConfig } from "../src/retention.js";

if (process.env.PI_GENERATION_RECOVERY_LIVE !== "1")
  throw new Error(
    "Set PI_GENERATION_RECOVERY_LIVE=1 to permit bounded live OAuth requests",
  );
const runtime = await ModelRuntime.create();
const model = runtime.getModel(
  "openai-codex",
  process.env.PI_LIVE_MODEL ?? "gpt-6-astra",
);
assert(
  model &&
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses",
);
const auth = await runtime.checkAuth("openai-codex");
assert.equal(
  auth?.type,
  "oauth",
  "Existing Pi OAuth authentication is required",
);
const root = await mkdtemp(join(tmpdir(), "generation-live-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
await mkdir(join(root, "context-prune"));
await writeFile(
  join(root, "context-prune", "settings.json"),
  JSON.stringify({
    enabled: true,
    pruneOn: "agentic-auto",
    summarizerModel: "default",
    showStartupNotice: false,
    showPruneStatusLine: false,
  }),
);
const sessions: AgentSession[] = [];
const originalFetch = globalThis.fetch;
const jiti = createJiti(import.meta.url);
const codebuffer = (await jiti.import("pi-codebuffer/index.ts", {
  default: true,
})) as ExtensionFactory;
const { createExtension } = (await jiti.import(
  "pi-codex-native-compaction",
)) as { createExtension: (config: object) => ExtensionFactory };
const pruner = (await jiti.import("pi-context-prune", {
  default: true,
})) as ExtensionFactory;
const metrics = newMetrics();
let opaqueOnly = true;
let interruptions = 0;
let cutsRemaining = 0;
let observedOpaque = false;
let observedText = false;
let completedItemCount = 0;
let opaqueObservedWithoutCut = false;
let cut = false;
let cutHadOpaqueState = false;
let armed = false;
let requestCount = 0;
const deadline = Date.now() + 600000;
let probeFailures = 0;
let sseResponses = 0;
let reasoningEvents = 0;
let textEvents = 0;
let completedReasoning = 0;
// Test-only response-body fault injection; delegates all auth, serialization and HTTP to Pi.
// SSE records are never logged or persisted by this shim.
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  assert(requestCount < 32, "Bounded live request budget exhausted");
  assert(Date.now() < deadline, "Live time budget exhausted");
  requestCount++;
  const signals = [AbortSignal.timeout(Math.max(1, deadline - Date.now()))];
  if (args[1]?.signal) signals.push(args[1].signal);
  const response = await originalFetch(args[0], {
    ...args[1],
    signal: AbortSignal.any(signals),
  });
  if (!armed || !response.ok || !response.body) return response;
  sseResponses++;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  observedOpaque = false;
  observedText = false;
  let reasoningDone = false;
  let shouldCut = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (shouldCut && (!opaqueOnly || (observedOpaque && observedText))) {
          interruptions++;
          cut = true;
          cutHadOpaqueState ||= observedOpaque;
          cutsRemaining--;
          armed = cutsRemaining > 0;
          controller.error(
            new TypeError("network error: controlled local interruption"),
          );
          await reader.cancel().catch(() => {});
          return;
        }
        while (true) {
          const normalized = buffer.replaceAll("\r\n", "\n");
          const boundary = normalized.indexOf("\n\n");
          if (boundary >= 0) {
            const record = normalized.slice(0, boundary + 2);
            buffer = normalized.slice(boundary + 2);
            for (const line of record.split("\n"))
              if (line.startsWith("data: ")) {
                try {
                  const event = JSON.parse(line.slice(6)) as {
                    type?: string;
                    item?: { type?: string; encrypted_content?: string };
                    delta?: string;
                  };
                  if (
                    event.type === "response.output_item.done" &&
                    event.item?.type === "reasoning" &&
                    event.item.encrypted_content
                  ) {
                    reasoningDone = true;
                    reasoningEvents++;
                  }
                  if (event.type === "response.output_text.delta") textEvents++;
                  if (
                    armed &&
                    (!opaqueOnly || reasoningDone) &&
                    event.type === "response.output_text.delta" &&
                    event.delta
                  ) {
                    shouldCut = true;
                  }
                } catch {
                  /* SSE keepalive / done records are not model state. */
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
          if (buffer.length > 1048576) {
            controller.error(new Error("Live fixture SSE bound exceeded"));
            await reader.cancel();
            return;
          }
        }
      },
      async cancel() {
        await reader.cancel();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
const settings = SettingsManager.inMemory({
  transport: "sse",
  retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 },
  compaction: { enabled: false, reserveTokens: 16000, keepRecentTokens: 0 },
});
let toolExecutions = 0;
async function make(
  manager = SessionManager.create(root, join(root, "sessions")),
) {
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
      "Isolated extension interoperability validation. Use only the provided tool when asked. Do not inspect local files.",
    extensionFactories: [
      generationRecovery({
        root: join(root, "journals"),
        metrics,
        onCheckpoint: (cp) => {
          completedReasoning += cp.providerMetadata?.completedReasoning ?? 0;
        },
      }),
      codebuffer,
      createExtension({}),
      pruner,
      (pi) => {
        pi.on("message_start", () => {
          observedOpaque = false;
          observedText = false;
        });
        pi.on("message_update", (e) => {
          const a = e.assistantMessageEvent;
          if (
            a.type === "thinking_end" &&
            a.partial.content.some(
              (c) => c.type === "thinking" && !!c.thinkingSignature,
            )
          ) {
            observedOpaque = true;
            completedItemCount++;
          }
          if (a.type === "text_delta" && a.delta) observedText = true;
        });
        pi.on("tool_call", (e) => {
          if (e.toolName === "context_prune") return;
          if (
            e.toolName === "codebuffer" &&
            ["create", "read"].includes(String(e.input.action)) &&
            e.input.name === "livecheck"
          )
            return;
          return {
            block: true,
            reason:
              "Live fixture allows only create/read of its own buffer and pruning",
          };
        });
      },
      createCodemodeExtension({ mode: "on" }),
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
    sessionManager: manager,
    resourceLoader: loader,
  });
  sessions.push(session);
  await session.bindExtensions({
    onError: () => {
      throw new Error("Live extension failure (details suppressed)");
    },
  });
  session.subscribe((e) => {
    if (e.type === "tool_execution_end" && e.toolName === "codebuffer") {
      if (e.isError) console.log(JSON.stringify({ liveToolError: true }));
      else toolExecutions++;
    }
  });
  return session;
}
function assertSuccess(session: AgentSession) {
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  if (last?.stopReason !== "stop") {
    const error = last?.errorMessage ?? "";
    const categories = [
      "ETIMEDOUT",
      "ECONNREFUSED",
      "fetch failed",
      "403",
      "401",
      "429",
      "unsupported",
      "not found",
      "encrypted",
      "connection",
      "timeout",
      "proxy",
      "disconnected",
      "rate limit",
      "parameter",
      "schema",
      "tool",
      "content",
      "function",
      "required",
      "strict",
      "messages",
      "instructions",
      "unexpected",
      "JSON",
      "invalid",
      "builtin",
      "custom",
      "arguments",
      "validation",
      "reasoning",
      "compaction",
      "signature",
      "not supported",
      "stream",
      "no content",
      "empty",
      "canonical",
      "cannot",
      "undefined",
      "reading",
      "not a",
      "not found",
      "missing",
      "failed",
      "error",
      "ended",
      "mismatch",
      "changed",
      "context",
      "session",
      "head",
      "loadout",
      "stale",
      "fingerprint",
      "identity",
      "response",
      "input",
      "output",
      "call",
      "adapter",
      "snapshot",
    ].filter((s) => error.toLowerCase().includes(s.toLowerCase()));
    console.log(
      JSON.stringify({
        liveFailure: true,
        stopReason: last?.stopReason,
        endpoint: new URL(model!.baseUrl).origin,
        categories,
        errorLength: error.length,
        requests: requestCount,
        completedItemCount,
        reasoningEvents,
        textEvents,
        interruptions,
        observedOpaque,
        observedText,
        stateResumeAttempts: metrics.stateResumeAttempts,
        stateResumeSuccesses: metrics.stateResumeSuccesses,
      }),
    );
  }
  assert(
    last?.stopReason === "stop",
    "Live assistant did not finish normally (payload suppressed)",
  );
}
const timeout = setTimeout(() => {
  for (const session of sessions) void session.abort();
}, 600000);
try {
  const session = await make();
  await session.prompt(
    "Write a 500-word explanation of crash-consistent coding workflows. No tools. This is a healthy baseline generation.",
  );
  assertSuccess(session);
  console.log(JSON.stringify({ stage: "healthy-long", requestCount }));
  await session.prompt(
    "Use codebuffer once to create a buffer named livecheck containing exactly this source: " +
      JSON.stringify("text(42); /* " + "durable fixture ".repeat(100) + " */") +
      ". Do not run it. Then acknowledge completion briefly.",
  );
  assertSuccess(session);
  assert.equal(toolExecutions, 1);
  await session.prompt(
    "Use codebuffer read on livecheck once, then briefly acknowledge. Do not run it.",
  );
  assertSuccess(session);
  assert.equal(toolExecutions, 2);
  await session.compact();
  assert(
    session.sessionManager.getBranch().some((e) => e.type === "compaction"),
  );
  await session.prompt(
    "Use context_prune once to summarize the preceding tool output, then briefly acknowledge. No other tools.",
  );
  assertSuccess(session);
  const pruned = session.sessionManager
    .getBranch()
    .some(
      (e) => e.type === "custom" && e.customType === "context-prune-frontier",
    );
  assert(pruned, "Actual context pruning must run");
  for (let probe = 0; probe < 3 && !cut; probe++) {
    armed = true;
    cutsRemaining = 1;
    opaqueOnly = true;
    await session.prompt(
      "Without tools, solve and carefully explain a retry correctness argument: a stream emits reasoning, a complete source revision, a tool result, then another interrupted assistant. Compare recovery at each boundary, derive invariants and give a rigorous 300-word test plan. Consider non-idempotent side effects and branch switches.",
    );
    if (
      session.messages.filter((m) => m.role === "assistant").at(-1)
        ?.stopReason !== "stop"
    ) {
      probeFailures++;
      console.log(
        JSON.stringify({
          probeFailure: probe,
          requestCount,
          completedItemCount,
          reasoningEvents,
          textEvents,
          interruptions,
          stateResumeAttempts: metrics.stateResumeAttempts,
        }),
      );
    }
    opaqueObservedWithoutCut ||= observedOpaque && !cut;
    armed = false;
  }
  const targetedStateResumeSuccesses = metrics.stateResumeSuccesses;
  const canonicalRecoveryPersisted = session.sessionManager
    .getBranch()
    .some(
      (e) =>
        e.type === "custom" &&
        e.customType === "pi-generation-recovery.v1" &&
        (e.data as { state?: string }).state === "canonicalized",
    );
  if (targetedStateResumeSuccesses)
    assert(
      canonicalRecoveryPersisted,
      "Recovered assistant canonicalization must be durable",
    );
  assert(
    !session.messages.some(
      (m) =>
        m.role === "user" &&
        JSON.stringify(m.content).includes(
          "The preceding assistant prefix is committed",
        ),
    ),
  );
  console.log(
    JSON.stringify({
      stage: "opaque-probes",
      requestCount,
      cut,
      completedItemCount,
      stateResumeAttempts: metrics.stateResumeAttempts,
      stateResumeSuccesses: metrics.stateResumeSuccesses,
    }),
  );
  if (!cut) {
    opaqueOnly = false;
    armed = true;
    cutsRemaining = 1;
    await session.prompt(
      "Write 500 words on crash consistency in coding agents, without tools.",
    );
  }
  // Two local cuts exhaust the one-retry budget; no extension may create a third request.
  opaqueOnly = false;
  armed = true;
  cutsRemaining = 2;
  const beforeRepeated = requestCount;
  await session.prompt(
    "Explain durable state transitions in 400 words without tools.",
  );
  assert.equal(requestCount - beforeRepeated, 2);
  assert.equal(
    session.messages.filter((m) => m.role === "assistant").at(-1)?.stopReason,
    "error",
  );
  armed = false;
  console.log(
    JSON.stringify({
      stage: "repeated-fault-bounded",
      requestCount,
      stateResumeSuccesses: metrics.stateResumeSuccesses,
    }),
  );
  await session.prompt(
    "Give one short sentence confirming this is a new ordinary turn, no tools.",
  );
  assertSuccess(session);
  await session.compact();
  console.log(
    JSON.stringify({
      liveInterruptionProbe: {
        cut,
        requestCount,
        sseResponses,
        reasoningEvents,
        textEvents,
        completedReasoning,
      },
    }),
  );
  assert(cut, "Controlled local text-stream cut must occur");
  if (cutHadOpaqueState) assert(metrics.stateResumeAttempts >= 1);
  if (targetedStateResumeSuccesses) assert(metrics.stateResumeSuccesses >= 1);
  assert.equal(toolExecutions, 2);
  const file = session.sessionManager.getSessionFile()!;
  session.dispose();
  const reopened = await make(SessionManager.open(file));
  await reopened.prompt(
    "Use codebuffer read on livecheck, then acknowledge its existence in one sentence. Do not run it.",
  );
  assertSuccess(reopened);
  assert.equal(toolExecutions, 3);
  await mkdir(join(root, "journals", "expired"));
  const oldFile = join(root, "journals", "expired", "old.frames");
  await writeFile(oldFile, "truncated diagnostic", { mode: 0o600 });
  await utimes(oldFile, 0, 0);
  const gc = await collectJournals(join(root, "journals"), retentionConfig());
  assert.equal(gc.gcDeletedFiles, 1);
  console.log(
    JSON.stringify(
      {
        live: true,
        gc,
        model: model.id,
        api: model.api,
        healthy: true,
        nativeCompaction: true,
        codebuffer: true,
        controlledInterruption: cut,
        cutHadOpaqueState,
        stateResume: metrics.stateResumeSuccesses,
        stateResumeAttempts: metrics.stateResumeAttempts,
        targetedStateResumeSuccesses,
        canonicalRecoveryPersisted,
        probeFailures,
        ordinaryFallbacks: metrics.fullRetryFallbacks,
        completedItemCount,
        opaqueObservedWithoutCut,
        interruptions,
        pruned,
        repeatedInterruptionBounded: true,
        reopen: true,
        requestCount,
        toolExecutions,
        usage: metrics.usage,
      },
      null,
      2,
    ),
  );
} finally {
  console.log(
    JSON.stringify({
      liveFinalCounters: {
        requestCount,
        interruptions,
        completedItemCount,
        stateResumeAttempts: metrics.stateResumeAttempts,
        stateResumeSuccesses: metrics.stateResumeSuccesses,
        fullRetryFallbacks: metrics.fullRetryFallbacks,
        usage: metrics.usage,
      },
    }),
  );
  clearTimeout(timeout);
  globalThis.fetch = originalFetch;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  sessions.forEach((s) => s.dispose());
  await rm(root, { recursive: true, force: true });
}
