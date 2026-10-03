# Changelog

## 0.2.0

- Add conservative opportunistic journal retention (7 days / 1 GiB), per-attempt active leases, Linux descriptor-anchored symlink-safe GC, bounded scans and local GC metrics.
- Add recovery-attempt counters without speculative token-saving estimates.
- Exercise actual pi-context-prune 2.1.0 with CodeBuffer, native compaction and built-in CodeMode across relevant load orders; changed pruning state rejects stale recovery.
- Pin supported Pi to exactly 1.0.0 (minimum, installed and newest available baseline), with explicit CI version assertion and public-entry version guard.
- Improve opt-in event-driven live fault targeting; complete isolated real Codex soak demonstrated one successful opaque-state recovery, bounded repeated failures, companion operations, reopen and GC.
- Preserve the v0.1 public lifecycle architecture, Pi-owned retry and tool/provider/compaction boundaries.

Limitations: automatic GC is validated on Linux only and quota is best effort; other platforms fail closed for GC. No universal provider compatibility, same-response cursor, cross-restart auto-replay, or guaranteed token/billing savings.

## 0.1.0

- Capture interrupted generations with Pi assistant frames and private, hash-chained bounded journals.
- Preserve completed Codex opaque reasoning and full assistant prefixes on Pi-authorized retries.
- Conservative pure-text semantic continuation, identity/headroom guards and exact overlap handling.
- Canonical successful assistant persistence without permanent recovery prompts.
- Deterministic real-SDK fault tests, optional companion compatibility matrix and packaged-install smoke.
- Local counters and reported provider usage; no telemetry or npm publication.

Limitations: no same-response cursor, automatic cross-restart replay, tool replay or advanced adapters beyond Codex Responses. Live interruption validated ordinary retry; completed opaque-state replay validated deterministically.
