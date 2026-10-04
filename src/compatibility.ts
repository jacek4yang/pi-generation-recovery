/** Version labels are not capabilities. Keep host upgrades user-controlled. */
export function assertRecoveryCapabilities(pi: unknown): void {
  const api = pi as Record<string, unknown> | null;
  const required = [
    "on",
    "appendEntry",
    "sendMessage",
    "getAllTools",
    "getActiveTools",
    "getThinkingLevel",
  ];
  const missing = required.filter(
    (key) => !api || typeof api[key] !== "function",
  );
  if (missing.length)
    throw new Error(
      `pi-generation-recovery requires Pi APIs: ${missing.join(", ")}. Recovery is disabled.`,
    );
}
