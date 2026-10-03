import { createHash } from "node:crypto";
import type {
  AssistantMessageFrame,
  AssistantMessage,
} from "@earendil-works/pi-ai";
export const OWNER = "pi-generation-recovery.v1";
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface Identity {
  session: string;
  head: string | null;
  source: string | null;
  turn: number;
  provider: string;
  api: string;
  model: string;
  thinking: string;
  systemHash: string;
  toolsHash: string;
}
export type Frontier =
  | "NOTHING_RECEIVED"
  | "PARTIAL_REASONING"
  | "COMPLETE_REASONING"
  | "PARTIAL_TEXT"
  | "COMPLETE_TEXT_ITEM"
  | "PARTIAL_TOOL_CALL"
  | "COMPLETE_TOOL_CALL"
  | "TERMINAL_COMPLETE";
export interface RecoveryPlan {
  safePrefix: number[];
  droppedTailKind: Frontier | null;
  completedReasoningItems: number;
  unsafeReasoningItemsDropped: number;
  partialToolCallsDropped: number;
  visibleTextBytes: number;
  candidate: "state-preserving" | "semantic" | "none";
}
export interface GenerationCheckpoint {
  plan?: RecoveryPlan;
  schema: 1;
  owner: typeof OWNER;
  id: string;
  attemptId: string;
  identity: Identity;
  state:
    | "capturing"
    | "complete"
    | "interrupted"
    | "aborted"
    | "stale"
    | "journal-failed";
  frontier: Frontier;
  frameCount: number;
  hash: string;
  journal: string;
  strategy: "full-pi-retry" | "none";
  candidate: "state-preserving" | "semantic" | "none";
  failure?: "error" | "aborted";
  usage?: AssistantMessage["usage"];
  providerMetadata?: {
    responseId?: string;
    completedReasoning: number;
    reasoningTokens?: number;
  };
}
export interface Capabilities {
  nativeSameResponseResume: boolean;
  opaqueReasoningReplay: boolean;
  completedItemReplay: boolean;
  assistantPrefixReplay: boolean;
  toolCallReplay: false;
  providerCursor: false;
}
export interface ProviderAdapter {
  api: string;
  capabilities: Capabilities;
  observe(data: unknown): void;
  completedReasoning: number;
  verifiesReasoning(signature: string): boolean;
  responseId?: string;
  reasoningTokens?: number;
}
function object(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
// Allowlist only. No raw payload, headers, encrypted blobs or error strings in metadata.
export function adapter(api: string): ProviderAdapter {
  const codex = api === "openai-codex-responses";
  const seen = new Set<string>();
  const verified = new Set<string>();
  return {
    api,
    capabilities: {
      nativeSameResponseResume: false,
      opaqueReasoningReplay: codex,
      completedItemReplay: codex,
      assistantPrefixReplay: codex,
      toolCallReplay: false,
      providerCursor: false,
    },
    completedReasoning: 0,
    verifiesReasoning(signature) {
      try {
        return verified.has(hash(JSON.parse(signature)));
      } catch {
        return false;
      }
    },
    observe(data) {
      if (!codex) return;
      const e = object(data);
      if (!e) return;
      const response = object(e.response);
      if (
        typeof response?.id === "string" &&
        response.id.length <= 256 &&
        /^resp_[a-zA-Z0-9_-]+$/.test(response.id)
      )
        this.responseId = response.id;
      const reasoning = object(
        object(response?.usage)?.output_tokens_details,
      )?.reasoning_tokens;
      if (
        e.type === "response.completed" &&
        typeof reasoning === "number" &&
        Number.isSafeInteger(reasoning) &&
        reasoning >= 0
      )
        this.reasoningTokens = reasoning;
      const item = object(e.item);
      if (
        e.type === "response.output_item.done" &&
        item?.type === "reasoning" &&
        typeof item.id === "string" &&
        item.id.length <= 256 &&
        !seen.has(item.id) &&
        seen.size < 128 &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0
      ) {
        seen.add(item.id);
        verified.add(hash(item));
        this.completedReasoning++;
      }
    },
  };
}
export class FrontierTracker {
  private blocks = new Map<
    number,
    {
      kind: "text" | "thinking" | "tool";
      done: boolean;
      bytes: number;
      signature?: string;
    }
  >();
  terminal = false;
  accept(f: AssistantMessageFrame): void {
    if (f.type === "start") return;
    const i = f.contentIndex;
    switch (f.type) {
      case "text_start":
        this.blocks.set(i, {
          kind: "text",
          done: false,
          bytes: Buffer.byteLength(f.content.text),
          signature: undefined,
        });
        break;
      case "thinking_start":
        this.blocks.set(i, {
          kind: "thinking",
          done: false,
          bytes: Buffer.byteLength(f.content.thinking),
          signature: undefined,
        });
        break;
      case "toolcall_start":
        this.blocks.set(i, {
          kind: "tool",
          done: false,
          bytes: 0,
          signature: undefined,
        });
        break;
      case "text_delta":
      case "thinking_delta": {
        const b = this.blocks.get(i);
        if (b) b.bytes += Buffer.byteLength(f.delta);
        break;
      }
      case "text_end":
      case "thinking_end": {
        const b = this.blocks.get(i);
        if (b) {
          b.done = true;
          b.bytes = Buffer.byteLength(f.content);
          b.signature =
            f.type === "thinking_end" ? f.thinkingSignature : undefined;
        }
        break;
      }
      case "toolcall_end": {
        const b = this.blocks.get(i);
        if (b) b.done = true;
        break;
      }
    }
  }
  get partialReasoning() {
    return [...this.blocks.values()].some(
      (b) => b.kind === "thinking" && !b.done,
    );
  }
  get completeReasoning() {
    return [...this.blocks.values()].filter(
      (b) => b.kind === "thinking" && b.done && b.signature,
    ).length;
  }
  get textBytes() {
    return [...this.blocks.values()]
      .filter((b) => b.kind === "text")
      .reduce((n, b) => n + b.bytes, 0);
  }
  get hasTools() {
    return [...this.blocks.values()].some((b) => b.kind === "tool");
  }
  get frontier(): Frontier {
    const b = [...this.blocks.values()];
    if (this.terminal) return "TERMINAL_COMPLETE";
    if (b.some((x) => x.kind === "tool" && !x.done)) return "PARTIAL_TOOL_CALL";
    if (this.hasTools) return "COMPLETE_TOOL_CALL";
    if (this.partialReasoning) return "PARTIAL_REASONING";
    if (b.some((x) => x.kind === "text" && x.bytes > 0 && !x.done))
      return "PARTIAL_TEXT";
    if (b.some((x) => x.kind === "text" && x.bytes > 0 && x.done))
      return "COMPLETE_TEXT_ITEM";
    if (this.completeReasoning) return "COMPLETE_REASONING";
    return "NOTHING_RECEIVED";
  }
  plan(a: ProviderAdapter, reasoningModel: boolean): RecoveryPlan {
    const blocks = [...this.blocks.entries()].sort(([i], [j]) => i - j);
    const result: RecoveryPlan = {
      safePrefix: [],
      droppedTailKind: null,
      completedReasoningItems: 0,
      unsafeReasoningItemsDropped: 0,
      partialToolCallsDropped: 0,
      visibleTextBytes: 0,
      candidate: "none",
    };
    for (const [position, [index, b]] of blocks.entries()) {
      const safeReasoning =
        b.kind === "thinking" &&
        b.done &&
        b.signature &&
        a.verifiesReasoning(b.signature);
      // Visible text is harmless to commit, including a final partial text block.
      // An unfinished non-final block is a barrier, never jump past it.
      const safeText =
        b.kind === "text" && (b.done || position === blocks.length - 1);
      if (
        result.droppedTailKind === null &&
        index === result.safePrefix.length &&
        (safeReasoning || safeText)
      ) {
        result.safePrefix.push(index);
        if (safeReasoning) result.completedReasoningItems++;
        if (safeText) result.visibleTextBytes += b.bytes;
      } else {
        result.droppedTailKind ??=
          b.kind === "tool"
            ? b.done
              ? "COMPLETE_TOOL_CALL"
              : "PARTIAL_TOOL_CALL"
            : b.kind === "thinking"
              ? "PARTIAL_REASONING"
              : "PARTIAL_TEXT";
        if (b.kind === "thinking") result.unsafeReasoningItemsDropped++;
        if (b.kind === "tool" && !b.done) result.partialToolCallsDropped++;
      }
    }
    if (!this.terminal && a.capabilities.assistantPrefixReplay) {
      if (
        result.completedReasoningItems > 0 &&
        a.capabilities.opaqueReasoningReplay
      )
        result.candidate = "state-preserving";
      else if (!reasoningModel && result.visibleTextBytes >= 4096)
        result.candidate = "semantic";
    }
    return result;
  }
  candidate(
    a: ProviderAdapter,
    reasoningModel: boolean,
  ): GenerationCheckpoint["candidate"] {
    return this.plan(a, reasoningModel).candidate;
  }
}
export function matchesIdentity(a: Identity, b: Identity): boolean {
  return hash(a) === hash(b);
}
// Deliberately conservative: opaque bytes + prefix may be more costly than token heuristics.
export function hasHeadroom(
  bytes: number,
  usedTokens: number | undefined,
  window: number,
  reserve: number,
): boolean {
  return (
    usedTokens !== undefined &&
    Number.isFinite(usedTokens) &&
    usedTokens >= 0 &&
    Number.isFinite(bytes) &&
    bytes >= 0 &&
    window > reserve &&
    usedTokens + bytes + reserve < window
  );
}
export function exactOverlap(
  prefix: string,
  suffix: string,
  bound = 8192,
): number {
  for (let n = Math.min(prefix.length, suffix.length, bound); n >= 32; n--) {
    const match = suffix.slice(0, n);
    if (new Set(match).size < 4) continue;
    if (
      n < suffix.length &&
      /[\uD800-\uDBFF]/.test(suffix[n - 1]!) &&
      /[\uDC00-\uDFFF]/.test(suffix[n]!)
    )
      continue;
    if (prefix.endsWith(match)) return n;
  }
  return 0;
}
