# Changelog

## 0.1.0

- Capture interrupted generations with Pi assistant frames and private, hash-chained bounded journals.
- Preserve completed Codex opaque reasoning and full assistant prefixes on Pi-authorized retries.
- Conservative pure-text semantic continuation, identity/headroom guards and exact overlap handling.
- Canonical successful assistant persistence without permanent recovery prompts.
- Deterministic real-SDK fault tests, optional companion compatibility matrix and packaged-install smoke.
- Local counters and reported provider usage; no telemetry or npm publication.

Limitations: no same-response cursor, automatic cross-restart replay, tool replay or advanced adapters beyond Codex Responses. Live interruption validated ordinary retry; completed opaque-state replay validated deterministically.
