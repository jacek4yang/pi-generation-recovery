// Local HTTP fault fixture using Pi's real OpenAI-Codex serializer and stream parser.
// Pattern adapted from the MIT-licensed pi-codebuffer SDK fixture (jacek4yang).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
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
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

export type Script = {
  text?: string;
  reasoning?: "partial" | "complete";
  tool?: { name: string; args: string; partial?: boolean };
  fail?: boolean;
  terminalError?: string;
  hold?: boolean;
};
export async function harness(
  options: {
    factories?: ExtensionFactory[];
    extensions?: string[];
    retry?: boolean;
    maxRetries?: number;
    reasoning?: boolean;
    contextWindow?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "generation-recovery-sdk-"));
  const payloads: Record<string, unknown>[] = [];
  const scripts: Script[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(426);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let data = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "zstd")
      data = zstdDecompressSync(data);
    const body = JSON.parse(data.toString()) as Record<string, unknown>;
    payloads.push(body);
    const compact = (body.input as { type?: string }[]).some(
      (i) => i.type === "compaction_trigger",
    );
    const summarizing = JSON.stringify(body.input).includes(
      "<tool-call-batch>",
    );
    const script = compact
      ? {}
      : summarizing
        ? {
            text: "Fixture tool output summarized; source revision remains durable.",
          }
        : (scripts.shift() ?? { text: "fixture-ok" });
    const n = payloads.length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (e: object) =>
      res.write("data: " + JSON.stringify(e) + "\n\n");
    send({
      type: "response.created",
      response: { id: "resp_" + n, status: "in_progress" },
    });
    const output: object[] = [];
    if (compact) {
      const item = {
        type: "compaction",
        id: "cmp_" + n,
        encrypted_content: "fixture-not-real",
      };
      output.push(item);
      send({ type: "response.output_item.done", output_index: 0, item });
    }
    if (script.reasoning) {
      const item = {
        type: "reasoning",
        id: "rs_" + n,
        summary: [{ type: "summary_text", text: "fixture reasoning" }],
        encrypted_content: "opaque-fixture-not-real",
      };
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: item.id, summary: [] },
      });
      send({
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      send({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "fixture reasoning",
      });
      if (script.reasoning === "complete")
        send({ type: "response.output_item.done", output_index: 0, item });
      output.push(item);
    }
    if (script.text !== undefined) {
      const index = output.length;
      const item = {
        type: "message",
        id: "msg_" + n,
        role: "assistant",
        content: [{ type: "output_text", text: script.text, annotations: [] }],
      };
      send({
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, content: [] },
      });
      send({
        type: "response.content_part.added",
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      // Several deltas exercise Pi's shared accumulator and encoder catch-up.
      for (let i = 0; i < script.text.length; i += 127)
        send({
          type: "response.output_text.delta",
          output_index: index,
          content_index: 0,
          delta: script.text.slice(i, i + 127),
        });
      if (!script.fail)
        send({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
    }
    if (script.tool) {
      const index = output.length;
      const item = {
        type: "function_call",
        id: "fc_" + n,
        call_id: "call_" + n,
        name: script.tool.name,
        arguments: script.tool.args,
      };
      send({
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, arguments: "" },
      });
      send({
        type: "response.function_call_arguments.delta",
        output_index: index,
        delta: script.tool.args,
      });
      if (!script.tool.partial)
        send({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
    }
    if (script.terminalError)
      send({
        type: "response.failed",
        response: {
          id: "resp_" + n,
          status: "failed",
          error: {
            code: "invalid_request_error",
            message: script.terminalError,
          },
        },
      });
    else if (!script.fail)
      send({
        type: "response.completed",
        response: {
          id: "resp_" + n,
          status: "completed",
          output,
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
    // Premature EOF, no response.completed: deterministic interrupted stream.
    if (!script.hold) res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const credentials = new InMemoryCredentialStore();
  const jwt =
    "x." +
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-only" },
      }),
    ).toString("base64url") +
    ".x";
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: jwt,
    refresh: "fixture",
    expires: Date.now() + 86400000,
  }));
  const model = {
    ...getModel("openai-codex", "gpt-6-astra"),
    ...(options.reasoning === undefined
      ? {}
      : { reasoning: options.reasoning }),
    ...(options.contextWindow === undefined
      ? {}
      : { contextWindow: options.contextWindow }),
    baseUrl: "http://127.0.0.1:" + address.port + "/backend-api",
  };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: model.baseUrl } },
    }),
  );
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(dir, "config.json"),
    modelsStorePath: join(dir, "models.json"),
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 },
    retry: {
      enabled: options.retry ?? true,
      maxRetries: options.maxRetries ?? 1,
      baseDelayMs: 1,
    },
    transport: "sse",
  });
  const sessions: AgentSession[] = [];
  async function make(manager = SessionManager.create(dir, dir)) {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: options.extensions ?? [],
      extensionFactories: [
        ...(options.factories ?? []),
        createCodemodeExtension({ mode: "on" }),
      ],
      systemPrompt: "Isolated deterministic fixture.",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      sessionManager: manager,
    });
    sessions.push(session);
    await session.bindExtensions({
      onError: (e) => {
        throw new Error(JSON.stringify(e));
      },
    });
    return session;
  }
  return {
    dir,
    scripts,
    payloads,
    make,
    settings,
    model,
    async close() {
      sessions.forEach((s) => s.dispose());
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
