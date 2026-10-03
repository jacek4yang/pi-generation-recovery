// Opt-in, bounded live validation. No production session or raw payload is written here.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
const sessions: AgentSession[] = [];
const originalFetch = globalThis.fetch;
const jiti = createJiti(import.meta.url);
const codebuffer = (await jiti.import("pi-codebuffer/index.ts", {
  default: true,
})) as ExtensionFactory;
const { createExtension } = (await jiti.import(
  "pi-codex-native-compaction",
)) as { createExtension: (config: object) => ExtensionFactory };
const metrics = newMetrics();
let cut = false;
let cutHadOpaqueState = false;
let armed = false;
let requestCount = 0;
let sseResponses = 0;
let reasoningEvents = 0;
let textEvents = 0;
let completedReasoning = 0;
// Test-only response-body fault injection; delegates all auth, serialization and HTTP to Pi.
// SSE records are never logged or persisted by this shim.
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  assert(requestCount < 16, "Bounded live request budget exhausted");
  const response = await originalFetch(...args);
  requestCount++;
  if (!armed || !response.ok || !response.body) return response;
  sseResponses++;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let reasoningDone = false;
  let shouldCut = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (shouldCut) {
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
                    event.type === "response.output_text.delta" &&
                    event.delta
                  ) {
                    shouldCut = true;
                    cut = true;
                    cutHadOpaqueState = reasoningDone;
                    armed = false;
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
}, 180000);
try {
  const session = await make();
  await session.prompt(
    "Reply with a single short greeting. No tool is needed.",
  );
  assertSuccess(session);
  await session.prompt(
    "Use codebuffer once to create a buffer named livecheck containing exactly text(42);. Do not run it. Then acknowledge completion briefly.",
  );
  assertSuccess(session);
  assert.equal(toolExecutions, 1);
  await session.compact();
  assert(
    session.sessionManager.getBranch().some((e) => e.type === "compaction"),
  );
  armed = true;
  await session.prompt(
    "Write about 450 words explaining how to validate a retry mechanism without repeating side effects. Use six numbered sections and no tools.",
  );
  assertSuccess(session);
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
  assert.equal(metrics.stateResumeSuccesses, cutHadOpaqueState ? 1 : 0);
  assert.equal(toolExecutions, 1);
  const file = session.sessionManager.getSessionFile()!;
  session.dispose();
  const reopened = await make(SessionManager.open(file));
  await reopened.prompt(
    "Use codebuffer read on livecheck, then acknowledge its existence in one sentence. Do not run it.",
  );
  assertSuccess(reopened);
  assert.equal(toolExecutions, 2);
  console.log(
    JSON.stringify(
      {
        live: true,
        model: model.id,
        api: model.api,
        healthy: true,
        nativeCompaction: true,
        codebuffer: true,
        controlledInterruption: cut,
        cutHadOpaqueState,
        stateResume: metrics.stateResumeSuccesses,
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
  clearTimeout(timeout);
  globalThis.fetch = originalFetch;
  sessions.forEach((s) => s.dispose());
  await rm(root, { recursive: true, force: true });
}
