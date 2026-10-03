import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageFrameEncoder,
  type AssistantMessageFrame,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Journal } from "./journal.js";
import {
  adapter,
  FrontierTracker,
  hash,
  OWNER,
  type GenerationCheckpoint,
  type Identity,
  type ProviderAdapter,
} from "./state.js";

export interface Metrics {
  capturedGenerations: number;
  interruptedGenerations: number;
  stateResumeSuccesses: number;
  semanticResumeSuccesses: number;
  fullRetryFallbacks: number;
  replayedInputBytes: number;
  avoidedRepeatedOutputBytes: number;
  reasoningStateReplayed: number;
  staleCheckpointsRejected: number;
  toolCallRecoveriesRefused: number;
  journalFailures: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reportedReasoningTokens: number;
    reasoningUsageReports: number;
  };
}
export interface CaptureOptions {
  root?: string;
  enabled?: boolean;
  onCheckpoint?: (checkpoint: GenerationCheckpoint) => void;
  metrics?: Metrics;
  mode?: "recovery" | "capture-only";
}
export const newMetrics = (): Metrics => ({
  capturedGenerations: 0,
  interruptedGenerations: 0,
  stateResumeSuccesses: 0,
  semanticResumeSuccesses: 0,
  fullRetryFallbacks: 0,
  replayedInputBytes: 0,
  avoidedRepeatedOutputBytes: 0,
  reasoningStateReplayed: 0,
  staleCheckpointsRejected: 0,
  toolCallRecoveriesRefused: 0,
  journalFailures: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reportedReasoningTokens: 0,
    reasoningUsageReports: 0,
  },
});
export function captureExtension(options: CaptureOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const metrics = options.metrics ?? newMetrics();
    // Capture can be used independently in shadow mode. It never changes retry or context.
    const enabled =
      options.enabled ?? process.env.PI_GENERATION_RECOVERY_CAPTURE === "1";
    const root =
      options.root ?? join(homedir(), ".pi", "agent", "generation-recovery");
    let turn = 0;
    let observation: ProviderAdapter | undefined;
    let active:
      | {
          id: string;
          identity: Identity;
          journal: Journal;
          encoder: AssistantMessageFrameEncoder;
          tracker: FrontierTracker;
          frames: number;
          invalid: boolean;
          adapter: ProviderAdapter;
          reasoning: boolean;
          timer: ReturnType<typeof setInterval>;
        }
      | undefined;
    const identity = (ctx: ExtensionContext): Identity => {
      const branch = ctx.sessionManager.getBranch();
      return {
        session: ctx.sessionManager.getSessionId(),
        head: ctx.sessionManager.getLeafId(),
        source:
          branch.findLast(
            (e) => e.type === "message" && e.message.role === "user",
          )?.id ?? null,
        turn,
        provider: ctx.model?.provider ?? "unknown",
        api: ctx.model?.api ?? "unknown",
        model: ctx.model?.id ?? "unknown",
        thinking: pi.getThinkingLevel(),
        systemHash: hash(ctx.getSystemPrompt()),
        toolsHash: hash({ all: pi.getAllTools(), active: pi.getActiveTools() }),
      };
    };
    const finish = async (
      state: GenerationCheckpoint["state"],
      failure?: "error" | "aborted",
      usage?: GenerationCheckpoint["usage"],
    ) => {
      const a = active;
      if (!a) return;
      active = undefined;
      clearInterval(a.timer);
      a.journal.append({
        kind: "settlement",
        state,
        failure,
        usage,
        frontier: a.tracker.frontier,
      });
      await a.journal.close();
      const failed = a.invalid || a.journal.failed;
      if (failed) metrics.journalFailures++;
      const candidate = a.tracker.candidate(a.adapter, a.reasoning);
      const cp: GenerationCheckpoint = {
        schema: 1,
        owner: OWNER,
        id: a.id,
        attemptId: a.id,
        identity: a.identity,
        state: failed ? "journal-failed" : state,
        frontier: a.tracker.frontier,
        frameCount: a.frames,
        hash: a.journal.digest,
        journal: join(a.identity.session, a.id + ".frames"),
        strategy: failure === "error" ? "full-pi-retry" : "none",
        candidate: failed ? "none" : candidate,
        ...(failure ? { failure } : {}),
        ...(usage ? { usage } : {}),
      };
      if (failure) {
        metrics.interruptedGenerations++;
        if (failure === "error") metrics.fullRetryFallbacks++;
        if (a.tracker.hasTools) metrics.toolCallRecoveriesRefused++;
      }
      cp.providerMetadata = {
        responseId: a.adapter.responseId,
        completedReasoning: a.adapter.completedReasoning,
        reasoningTokens: a.adapter.reasoningTokens,
      };
      if (usage) {
        metrics.usage.input += usage.input;
        metrics.usage.output += usage.output;
        metrics.usage.cacheRead += usage.cacheRead;
        metrics.usage.cacheWrite += usage.cacheWrite;
      }
      if (a.adapter.reasoningTokens !== undefined) {
        metrics.usage.reportedReasoningTokens += a.adapter.reasoningTokens;
        metrics.usage.reasoningUsageReports++;
      }
      // Only bounded, non-context metadata. No custom_message or mutations of other entries.
      pi.appendEntry(OWNER, cp);
      options.onCheckpoint?.(cp);
    };
    pi.registerCommand("generation-recovery", {
      description:
        "Show local recovery mode, metrics and reported provider usage",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          JSON.stringify({
            mode: enabled ? (options.mode ?? "capture-only") : "disabled",
            ...metrics,
          }),
          "info",
        );
      },
    });
    if (!enabled) return;
    pi.on("turn_start", async (e) => {
      await finish("stale");
      turn = e.turnIndex;
      observation = undefined;
    });
    pi.on("provider_stream_event", (e) => {
      observation ??= adapter(e.api);
      if (observation.api === e.api) observation.observe(e.data);
    });
    pi.on("message_start", (e, ctx) => {
      if (e.message.role !== "assistant") return;
      const id = randomUUID();
      const binding = identity(ctx);
      const journal = Journal.create(root, binding.session, id);
      journal.append({ kind: "identity", identity: binding, attemptId: id });
      observation ??= adapter(binding.api);
      active = {
        id,
        identity: binding,
        journal,
        encoder: new AssistantMessageFrameEncoder(),
        tracker: new FrontierTracker(),
        frames: 0,
        invalid: false,
        adapter: observation,
        reasoning: ctx.model?.reasoning ?? true,
        timer: setInterval(() => journal.flush(), 250),
      };
      active.timer.unref();
      metrics.capturedGenerations++;
      const start = active.encoder.encode({
        type: "start",
        partial: e.message,
      });
      if (start) {
        if (start.type === "start") delete start.partial.diagnostics;
        append(start);
      }
    });
    function append(frame: AssistantMessageFrame): void {
      if (!active || active.invalid) return;
      try {
        active.tracker.accept(frame);
        if (active.journal.append({ kind: "frame", frame })) active.frames++;
        else active.invalid = true;
      } catch {
        active.invalid = true;
      }
    }
    pi.on("message_update", (e) => {
      if (!active || active.invalid) return;
      // Pi's message_start supplies the start accumulator; updates omit that event.
      if (e.assistantMessageEvent.type === "start") return;
      try {
        const frame = active.encoder.encode(e.assistantMessageEvent);
        if (frame) append(frame);
      } catch {
        active.invalid = true;
      }
    });
    pi.on("message_end", async (e) => {
      if (e.message.role !== "assistant" || !active) return;
      const reason = e.message.stopReason;
      active.tracker.terminal = reason === "stop" || reason === "toolUse";
      await finish(
        reason === "aborted"
          ? "aborted"
          : reason === "error"
            ? "interrupted"
            : "complete",
        reason === "error" || reason === "aborted" ? reason : undefined,
        e.message.usage,
      );
    });
    pi.on("session_shutdown", async () => {
      await finish("stale");
    });
  };
}
