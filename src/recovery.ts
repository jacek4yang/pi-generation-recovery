import {
  reduceAssistantMessageFrames,
  type AssistantMessage,
  type AssistantMessageFrame,
} from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJournal } from "./journal.js";
import { replayEstimate } from "./headroom.js";
import type {
  BoundaryState,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  captureExtension,
  newMetrics,
  type CaptureOptions,
} from "./extension.js";
import {
  exactOverlap,
  hash,
  hasHeadroom,
  OWNER,
  type GenerationCheckpoint,
} from "./state.js";

const INSTRUCTION =
  "The preceding assistant prefix is committed output from this same interrupted generation. Continue from that safe frontier; do not regenerate or summarize the committed prefix. Preserve its decisions and completed reasoning state. Any incomplete reasoning or tool-call tail was discarded, not executed. Generate any necessary next tool call afresh; prefer smaller independently valid calls and retained-source edits instead of reproducing a large discarded tool argument. Finish the original task with unchanged quality. Do not repeat tool actions from the transcript.";
interface Pending {
  checkpoint: GenerationCheckpoint;
  prefix: AssistantMessage;
  failedId?: string;
  applied: boolean;
  bytes: number;
  estimatedTokens: number;
}
function ownedMarker(e: SessionEntry, id?: string): boolean {
  return (
    e.type === "custom_message" &&
    e.customType === OWNER &&
    (!id || (e.details as { attemptId?: string } | undefined)?.attemptId === id)
  );
}
function cleanPrefix(message: AssistantMessage): AssistantMessage {
  const {
    errorMessage: _error,
    diagnostics: _diagnostics,
    ...copy
  } = structuredClone(message);
  void _error;
  void _diagnostics;
  return { ...copy, stopReason: "stop" };
}
/** Exact byte-for-byte textual overlap only; never removes reasoning or tool blocks. */
export function canonicalize(
  prefix: AssistantMessage,
  completion: AssistantMessage,
): { message: AssistantMessage; overlap: number } {
  const left = structuredClone(prefix.content);
  const right = structuredClone(completion.content);
  const prior = left
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const first = right.find((c) => c.type === "text");
  const overlap = first ? exactOverlap(prior, first.text) : 0;
  if (first) first.text = first.text.slice(overlap);
  // Usage belongs to this provider request, not a fabricated sum across attempts.
  return { message: { ...completion, content: [...left, ...right] }, overlap };
}
export function generationRecovery(options: CaptureOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const metrics = options.metrics ?? newMetrics();
    let last: GenerationCheckpoint | undefined;
    let pending: Pending | undefined;
    const enabled = options.enabled ?? true;
    captureExtension({
      ...options,
      enabled,
      metrics,
      mode: "recovery",
      onCheckpoint: (cp) => {
        last = cp;
        options.onCheckpoint?.(cp);
      },
    })(pi);
    if (!enabled) return;
    const reasons = new WeakMap<GenerationCheckpoint, string>();
    function fallback(cp: GenerationCheckpoint, reason?: string) {
      const old = reasons.get(cp);
      if (old)
        metrics.fallbackReasons[old] = Math.max(
          0,
          (metrics.fallbackReasons[old] ?? 0) - 1,
        );
      if (reason && reason !== old)
        pi.appendEntry(OWNER, {
          state: "fallback",
          attemptId: cp.attemptId,
          reason,
        });
      if (reason) {
        reasons.set(cp, reason);
        metrics.fallbackReasons[reason] =
          (metrics.fallbackReasons[reason] ?? 0) + 1;
      } else reasons.delete(cp);
    }
    const stale = () => {
      if (pending) {
        metrics.staleCheckpointsRejected++;
        fallback(pending.checkpoint, "identity-or-branch-changed");
        pending = undefined;
      }
    };
    function fits(estimatedTokens: number, ctx: ExtensionContext): boolean {
      const window = ctx.model?.contextWindow ?? 0;
      // Post-compaction usage can be unknown. Bound ALL persisted branch bytes, including
      // opaque native state, rather than pretending a short summary is the actual context.
      let used = ctx.getContextUsage()?.tokens;
      if (used == null) {
        used =
          Buffer.byteLength(ctx.getSystemPrompt()) +
          Buffer.byteLength(JSON.stringify(pi.getAllTools()));
        for (const entry of ctx.sessionManager.getBranch()) {
          used += Buffer.byteLength(JSON.stringify(entry));
          if (used >= window) return false;
        }
      }
      return hasHeadroom(
        estimatedTokens,
        used,
        window,
        Math.max(8192, ctx.model?.maxTokens ?? 0),
      );
    }
    pi.on("session_start", stale);
    pi.on("session_tree", stale);
    pi.on("model_select", stale);
    pi.on("thinking_level_select", stale);
    const valid = (p: Pending, ctx: ExtensionContext): boolean => {
      const b = p.checkpoint.identity;
      const branch = ctx.sessionManager.getBranch();
      if (!branch.some((e) => e.id === p.failedId)) return false;
      if (
        b.session !== ctx.sessionManager.getSessionId() ||
        b.provider !== ctx.model?.provider ||
        b.api !== ctx.model.api ||
        b.model !== ctx.model.id ||
        b.thinking !== pi.getThinkingLevel() ||
        b.systemHash !== hash(ctx.getSystemPrompt()) ||
        b.toolsHash !==
          hash({ all: pi.getAllTools(), active: pi.getActiveTools() })
      )
        return false;
      if (
        b.source !==
        (branch.findLast(
          (e) => e.type === "message" && e.message.role === "user",
        )?.id ?? null)
      )
        return false;
      const head =
        b.head === null ? -1 : branch.findIndex((e) => e.id === b.head);
      if (b.head !== null && head < 0) return false;
      // Only exact owned bookkeeping + the failed assistant + Pi's omission may follow the head.
      return branch
        .slice(head + 1)
        .every(
          (e) =>
            e.id === p.failedId ||
            (e.type === "custom" && e.customType === OWNER) ||
            ownedMarker(e) ||
            (e.type === "context_edit" &&
              e.targetId === p.failedId &&
              e.replacement === null),
        );
    };
    pi.on("message_end", async (e, ctx) => {
      if (e.message.role !== "assistant" || !last) return;
      const message = e.message;
      if (message.stopReason === "error") {
        // Never queue a continuation. This empty marker cannot trigger a request and serializes to nothing.
        const prior = pending?.applied ? pending : undefined;
        const cp = { ...last };
        pending = undefined;
        fallback(cp, "pi-retry-not-authorized");
        if (
          prior &&
          [
            "session",
            "source",
            "provider",
            "api",
            "model",
            "thinking",
            "systemHash",
            "toolsHash",
          ].some(
            (k) =>
              cp.identity[k as keyof typeof cp.identity] !==
              prior.checkpoint.identity[k as keyof typeof cp.identity],
          )
        ) {
          metrics.staleCheckpointsRejected++;
          fallback(cp, "identity-or-branch-changed");
          return;
        }
        if (prior && cp.candidate === "none") {
          cp.candidate = prior.checkpoint.candidate;
          if (cp.state === "interrupted") metrics.recoverableSafePrefixes++;
        }
        if (cp.state !== "interrupted" || cp.candidate === "none") {
          fallback(
            cp,
            cp.state === "journal-failed"
              ? "journal-invalid"
              : "no-safe-prefix",
          );
          return;
        }
        let reconstructed: AssistantMessage;
        try {
          const records = await readJournal(
            join(
              options.root ??
                join(homedir(), ".pi", "agent", "generation-recovery"),
              cp.journal,
            ),
          );
          if (records.at(-1)?.hash !== cp.hash)
            throw new Error("Checkpoint hash mismatch");
          const frames = records.flatMap((r) => {
            const d = r.data as { kind: string; frame?: AssistantMessageFrame };
            return d.kind === "frame" ? [d.frame!] : [];
          });
          if (frames.length !== cp.frameCount)
            throw new Error("Checkpoint frame count mismatch");
          const settlement = records.at(-1)?.data as {
            plan?: GenerationCheckpoint["plan"];
          };
          if (!cp.plan || hash(cp.plan) !== hash(settlement.plan))
            throw new Error("Checkpoint plan mismatch");
          const indices = cp.plan.safePrefix;
          if (indices.some((v, i) => v !== i))
            throw new Error("Non-contiguous safe frontier");
          // Filter BEFORE reducing. Partial tool JSON is never parsed into an action.
          const safeIndices = new Set(indices);
          const safeFrames = frames.filter(
            (f) =>
              f.type === "start" ||
              (safeIndices.has(f.contentIndex) &&
                !f.type.startsWith("toolcall")),
          );
          const reduced = reduceAssistantMessageFrames(safeFrames);
          if (
            !reduced ||
            reduced.content.length !== indices.length ||
            reduced.content.some((c) => c.type === "toolCall")
          )
            throw new Error("Invalid safe frontier");
          reconstructed = reduced;
        } catch {
          metrics.journalFailures++;
          fallback(cp, "journal-invalid");
          return;
        }
        const restored = cleanPrefix({
          ...reconstructed,
          usage: message.usage,
        });
        const prefix = prior
          ? canonicalize(prior.prefix, restored).message
          : restored;
        const bytes =
          Buffer.byteLength(JSON.stringify(prefix.content)) +
          Buffer.byteLength(INSTRUCTION);
        const { estimatedTokens } = replayEstimate(prefix, INSTRUCTION);
        if (!fits(estimatedTokens, ctx)) {
          fallback(cp, "insufficient-headroom");
          return;
        }
        pending = {
          checkpoint: cp,
          prefix,
          bytes,
          estimatedTokens,
          applied: false,
        };
        if (prior)
          pi.appendEntry(OWNER, {
            state: "chained",
            attemptId: cp.attemptId,
            parentAttemptId: prior.checkpoint.attemptId,
          });
        pi.sendMessage(
          {
            customType: OWNER,
            content: [],
            display: false,
            details: { attemptId: cp.attemptId, state: "pending" },
          },
          { triggerTurn: false },
        );
        return;
      }
      if (
        pending?.applied &&
        (message.stopReason === "stop" || message.stopReason === "toolUse")
      ) {
        const p = pending;
        pending = undefined;
        // Model, system and tools are rechecked before committing a combined assistant.
        const b = p.checkpoint.identity;
        if (
          b.provider !== message.provider ||
          b.api !== message.api ||
          b.model !== message.model ||
          b.toolsHash !==
            hash({ all: pi.getAllTools(), active: pi.getActiveTools() }) ||
          b.systemHash !== hash(ctx.getSystemPrompt())
        ) {
          metrics.staleCheckpointsRejected++;
          return;
        }
        const combined = canonicalize(p.prefix, message);
        if (p.checkpoint.candidate === "state-preserving")
          metrics.stateResumeSuccesses++;
        else metrics.semanticResumeSuccesses++;
        metrics.avoidedRepeatedOutputBytes += Buffer.byteLength(
          message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("")
            .slice(0, combined.overlap),
        );
        pi.appendEntry(OWNER, {
          state: "canonicalized",
          attemptId: p.checkpoint.attemptId,
          completionAttemptId: last.attemptId,
          overlapCharacters: combined.overlap,
        });
        return { message: combined.message };
      }
      if (message.stopReason === "aborted") pending = undefined;
    });
    pi.on("turn_end", (e, ctx) => {
      if (
        pending &&
        !pending.applied &&
        e.message.role === "assistant" &&
        e.message.stopReason === "error"
      )
        pending.failedId = e.messageEntryId;
      if (!pending) return cleanup(e, ctx);
    });
    function cleanup(event: BoundaryState, ctx: ExtensionContext) {
      const already = new Set(
        ctx.sessionManager
          .getBranch()
          .flatMap((e) =>
            e.type === "context_edit" && e.replacement === null
              ? [e.targetId]
              : [],
          ),
      );
      const entries = ctx.sessionManager
        .getBranch()
        .filter((e) => ownedMarker(e) && !already.has(e.id))
        .map((e) => ({
          type: "context_edit" as const,
          targetId: e.id,
          replacement: null,
        }));
      return entries.length
        ? { entries: [...event.entries, ...entries] }
        : undefined;
    }
    pi.on("context", (e, ctx) => {
      const p = pending;
      if (!p || p.applied || !p.failedId) return;
      const branch = ctx.sessionManager.getBranch();
      // Pi's persisted omission is the authorization: actual normal retry, not guessed error text.
      if (
        !branch.some(
          (x) =>
            x.type === "context_edit" &&
            x.targetId === p.failedId &&
            x.replacement === null,
        )
      ) {
        if (!valid(p, ctx)) stale();
        return;
      }
      if (!valid(p, ctx)) {
        stale();
        return;
      }
      if (!fits(p.estimatedTokens, ctx)) {
        fallback(p.checkpoint, "insufficient-headroom");
        pending = undefined;
        return;
      }
      const marker = e.messages.findIndex(
        (m) =>
          m.role === "custom" &&
          m.customType === OWNER &&
          (m.details as { attemptId?: string } | undefined)?.attemptId ===
            p.checkpoint.attemptId,
      );
      if (marker < 0) {
        stale();
        return;
      }
      p.applied = true;
      metrics.fullRetryFallbacks--;
      fallback(p.checkpoint);
      metrics.completedReasoningItemsPreserved += p.prefix.content.filter(
        (c) => c.type === "thinking",
      ).length;
      metrics.replayedInputBytes += p.bytes;
      if (p.checkpoint.candidate === "state-preserving") {
        metrics.reasoningStateReplayed++;
        metrics.stateResumeAttempts++;
      } else metrics.semanticResumeAttempts++;
      pi.appendEntry(OWNER, {
        state: "replaying",
        attemptId: p.checkpoint.attemptId,
        strategy: p.checkpoint.candidate,
        failedEntryId: p.failedId,
      });
      return {
        messages: [
          ...e.messages.slice(0, marker),
          p.prefix,
          {
            role: "user" as const,
            content: INSTRUCTION,
            timestamp: Date.now(),
          },
          ...e.messages.slice(marker + 1),
        ],
      };
    });
    // This boundary is only reached AFTER Pi declines further automatic retry.
    pi.on("agent_before_settle", (e, ctx) => {
      pending = undefined;
      return cleanup(e, ctx);
    });
  };
}
