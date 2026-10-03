# pi-generation-recovery

State-aware interrupted-generation recovery for **Pi >= 1.0.0 / Node >= 24**. Pi remains the retry owner; this extension preserves safely replayable model work when Pi authorizes a retry. No telemetry, provider replacement, authentication, tool execution, or compaction layer.

## Install

```sh
pi install git:github.com/jacek4yang/pi-generation-recovery@v0.1.0
```

Restart Pi or reload extensions. No npm publication. The public source entry is `index.ts`.

## Recovery policy

Advanced recovery in v0.1.0 supports **openai-codex-responses** only.

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
- `/generation-recovery`: show process-local counters and reported usage.

Retry enablement, budget and backoff are configured in Pi, not here. Metrics distinguish reported input/output/cache/reasoning usage from replayed bytes. Exact repeated bytes removed from the transcript are **not token or billing savings**. Failed streams may have no usage report.

## Privacy and storage

Journals contain private assistant text and provider-exposed opaque reasoning signatures, like private session data. They do not contain request headers, auth tokens or raw provider event dumps. Generation content can itself contain sensitive information: protect the directory and backups. Directories/files use restrictive permissions where supported.

Each append-only journal is bounded to 32 MiB, with bounded buffering; a truncated final record is ignored. Earlier committed records survive a later write failure. There is **no automatic retention policy or global disk quota** in v0.1.0. With Pi stopped, delete old session subdirectories to reclaim space; deleted journals cannot be used for recovery. Never upload journals to an issue.

## Independent durability layers

Optional companions are not runtime dependencies. Recovery does not alter their entries or expose/execute their tools:

- `pi-codebuffer`: revisioned program source.
- `pi-codex-native-compaction`: long-session Codex checkpoints and provider wrapper.
- This extension: interrupted current inference.

See [architecture](docs/ARCHITECTURE.md), [failure model](docs/FAILURE_MODEL.md), [compatibility](docs/COMPATIBILITY.md), [testing](docs/TESTING.md), and [security](SECURITY.md).
