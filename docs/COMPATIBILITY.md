# Compatibility

Supported runtime: Node >=24, Pi >=1.0.0; tested baseline Pi 1.0.0. No pre-1.0 compatibility code. Advanced adapter: `openai-codex-responses`; other APIs capture only. Later Pi versions must preserve the tested public lifecycle/omission contract.

Optional test companions (not runtime dependencies):

| Companion                  | Verified version/source                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| pi-codebuffer              | v0.1.0, main `e46b4b33e592b7ff5bc8681399937646ce6d1cb3`                  |
| pi-codex-native-compaction | v0.3.2 release artifact, main `eb8eb89617030b30de322afec12d1fafb778b31d` |

Their current main implementations, architecture, tests, metadata, releases and protected-main settings were audited read-only. Neither repository was modified. Production recovery imports neither companion.

The real SDK matrix covers recovery only, recovery + CodeBuffer, recovery + native compaction, and all three, in reversed package-extension orders. The SDK harness explicitly registers the built-in CodeMode extension **after package extensions**, matching Pi package loading; this is CodeBuffer setup, not recovery load-order coupling. CodeBuffer must have its usual CodeMode environment.

Tests require a successful CodeBuffer create, durable revision state, no repeated create across a later interrupted generation, reopen/read, preserved native checkpoint data, pending-state deferral and a subsequent successful native checkpoint. Recovery uses neither `before_provider_request`, provider registration nor `session_before_compact`. Native compaction remains the sole compaction/provider-wrapper owner.

Recovery bookkeeping owns only `pi-generation-recovery.v1`. CodeBuffer and native custom entries are left unchanged. Existing native checkpoints participate through Pi canonical transcript serialization; no native payload is manually injected. Session reopen preserves companion state but does not automatically replay an interrupted generation.
