import test from "node:test";
import assert from "node:assert/strict";
import { replayEstimate } from "../src/headroom.js";
import { hasHeadroom } from "../src/state.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
test("headroom separates visible estimates from opaque state and unknown usage", () => {
  const p = {
    role: "assistant",
    content: [
      { type: "text", text: "ordinary English sentence. ".repeat(1000) },
    ],
  } as AssistantMessage;
  const a = replayEstimate(p, "continue");
  assert(a.estimatedTokens < Buffer.byteLength(JSON.stringify(p)));
  assert(a.estimatedTokens > p.content.length);
  assert.equal(a.opaqueBytes, 0);
  p.content.push({
    type: "thinking",
    thinking: "summary",
    thinkingSignature: "opaque".repeat(10000),
  });
  const b = replayEstimate(p, "continue");
  assert.equal(b.opaqueBytes, 60000);
  assert(b.estimatedTokens >= 60000 + a.estimatedTokens);
  assert(!hasHeadroom(b.estimatedTokens, 10000, 65536, 8192));
  assert(!hasHeadroom(100, undefined, 65536, 8192));
  p.content = [{ type: "text", text: "🧪中文".repeat(1000) }];
  assert(
    replayEstimate(p, "").visibleEstimate >=
      Buffer.byteLength("🧪中文".repeat(1000)),
  );
});
