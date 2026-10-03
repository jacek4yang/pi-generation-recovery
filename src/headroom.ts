import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
/** Admission estimate, NOT tokenizer/billing data. Pi's estimator omits signatures. */
export function replayEstimate(
  prefix: AssistantMessage,
  instruction: string,
): { estimatedTokens: number; opaqueBytes: number; visibleEstimate: number } {
  const visible =
    prefix.content
      .map((c) =>
        c.type === "thinking" ? c.thinking : c.type === "text" ? c.text : "",
      )
      .join("") + instruction;
  const sdk =
    estimateTokens(prefix) +
    estimateTokens({ role: "user", content: instruction, timestamp: 0 });
  // Twice Pi's visible-text estimate, with a UTF-8 bound for non-ASCII text.
  // Keep ciphertext conservative: public Pi cannot estimate its decoded state.
  const nonAsciiBytes = Buffer.byteLength(visible.replace(/[\x00-\x7f]/g, ""));
  const visibleEstimate =
    Math.max(sdk * 2, nonAsciiBytes) + 256 + prefix.content.length * 64;
  const opaqueBytes = prefix.content.reduce(
    (n, c) =>
      n +
      (c.type === "thinking" && c.thinkingSignature
        ? Buffer.byteLength(c.thinkingSignature)
        : 0),
    0,
  );
  return {
    estimatedTokens: visibleEstimate + opaqueBytes,
    opaqueBytes,
    visibleEstimate,
  };
}
