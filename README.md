# pi-generation-recovery

State-aware interrupted-generation recovery for **Pi 1.0.0 / Node >= 24**. Pi remains the retry owner; this extension preserves safely replayable model work when Pi authorizes a retry. No telemetry, provider replacement, authentication, tool execution, or compaction layer.

## Install

```sh
pi install git:github.com/jacek4yang/pi-generation-recovery@v0.2.0
```

Restart Pi or reload extensions. No npm publication. The public source entry is `index.ts`.

## Recovery policy

Advanced recovery in v0.2.0 supports **openai-codex-responses** only.

| Interrupted generation                                   | Behavior                                             |
| -------------------------------------------------------- | ---------------------------------------------------- |
| Completed opaque reasoning item + assistant text         | State-preserving resume through canonical Pi context |
| Pure-text model + at least 4 KiB text                    | Semantic continuation                                |
| Missing/incomplete reasoning, no meaningful output       | Ordinary Pi retry                                    |
| Any tool-call content                                    | Ordinary Pi retry; never execute/replay tools        |
| Abort, exhausted/disabled retry, non-retryable error     | No extra request                                     |
| Changed identity, insufficient headroom, journal failure | Fail closed; ordinary Pi behavior                    |
| Other provider APIs                                      | Capture only                                         |

There is no documented reliable same-response cursor for the supported subscription channel. State resume is a **new request**, preserving completed exposed reasoning and the entire committed prefix; it cannot guarantee identical internal inference or identical quality. Incomplete reasoning summaries are never treated as complete reasoning state. Context overflow remains Pi/native compaction territory.

Successful recovery persists a combined canonical assistant response. Only sufficiently long, diverse, exact suffix/prefix overlap is removed; uncertain repetitions remain. A session restart does not authorize automatic replay of old checkpoints.

## Configuration and local metrics

- `PI_GENERATION_RECOVERY_MODE=on` (default): capture and eligible recovery.
- `PI_GENERATION_RECOVERY_MODE=shadow`: capture only.
- `PI_GENERATION_RECOVERY_MODE=off`: disable capture/recovery. Unknown values also disable.
- `PI_GENERATION_RECOVERY_DIR`: override the private journal root (default `~/.pi/agent/generation-recovery`).
- `PI_GENERATION_RECOVERY_RETENTION_DAYS=7`: inactive journal age limit; 0 disables age expiry.
- `PI_GENERATION_RECOVERY_MAX_TOTAL_BYTES=1073741824`: best-effort total quota; 0 disables size eviction.
- `/generation-recovery`: show process-local recovery attempts/successes, GC counters and reported usage.

Retry enablement, budget and backoff are configured in Pi, not here. Metrics distinguish reported input/output/cache/reasoning usage from replayed bytes. Exact repeated bytes removed from the transcript are **not token or billing savings**. Failed streams may have no usage report.

## Privacy and storage

Journals contain private assistant text and provider-exposed opaque reasoning signatures, like private session data. They do not contain request headers, auth tokens or raw provider event dumps. Generation content can itself contain sensitive information: protect the directory and backups. Directories/files use restrictive permissions where supported.

Each append-only journal is bounded to 32 MiB, with bounded buffering; a truncated final record is ignored. Earlier committed records survive a later write failure. Opportunistic GC defaults to **7 days / 1 GiB** and protects active/recovery journals. It runs at startup and at most hourly at settled boundaries, not per frame. Active data and concurrent changes can temporarily exceed quota. Linux descriptor-anchored deletion is supported; other platforms fail closed for automatic GC and require manual retention. See [retention semantics and limits](docs/RETENTION.md). Never upload journals to an issue.

## Independent durability layers

Optional companions are not runtime dependencies. Recovery does not alter their entries or expose/execute their tools:

- `pi-codebuffer`: revisioned program source.
- `pi-codex-native-compaction`: long-session Codex checkpoints and provider wrapper.
- `pi-context-prune@2.1.0`: tool-result context transformations.
- This extension: interrupted current inference.

## Validation and limits

The public Pi retry/omission lifecycle is pinned to **1.0.0**: minimum, installed daily-use, and newest registry version all matched at validation time. Other versions are rejected clearly until tested. This is a conservative v0.2 daily-driver candidate, not a universal compatibility or quality guarantee.

A bounded isolated real Codex soak passed with all four plugins, one **successful state-preserving recovery**, controlled repeated failures bounded by Pi, session reopen and GC. See [sanitized evidence](docs/validation-live.json). Deterministic real-SDK tests and installed-tarball tests cover unsafe fallbacks and plugin ordering.

Long coding workloads can benefit when replayed input replaces repeated reasoning/output generation, but input replay itself costs tokens. Cache behavior and provider-hidden work vary: **total token or billing savings are not guaranteed**. Byte counters are not token estimates.

See [architecture](docs/ARCHITECTURE.md), [failure model](docs/FAILURE_MODEL.md), [compatibility](docs/COMPATIBILITY.md), [testing](docs/TESTING.md), and [security](SECURITY.md).
