# Testing

```sh
npm ci --no-audit --no-fund
npm run check
npm run format:check
npm pack --json
npm run smoke
```

`check` runs strict TypeScript, ESLint and deterministic Node tests. Tests use the actual pinned Pi 1.0.0 SDK and Codex Responses provider with a local HTTP/SSE fault server and fake isolated credentials. Deterministic tests are offline. The packaged smoke installs the actual tarball into a temporary environment, rewrites test imports to installed source, and runs the same suite plus actual optional companions. It does not accidentally test checkout source.

Coverage includes healthy request equivalence, disabled/exhausted retries, no output, partial/complete reasoning, Unicode/Markdown prefixes, semantic continuation, interrupted tools, repeated interruption, abort/non-retryable failure, canonical future requests, stale identity, headroom, journal errors, corruption/truncation, abrupt writer exit, observer privacy, plugin ordering and reopen. GC tests cover age, quota ordering, active attempts within otherwise collectible sessions, stale leases, permissions, errors, invalid/disabled configuration, symlinks and parent-directory replacement races.

The SDK contract tests demonstrate `message_end` before persistence, `turn_end` afterward, Pi-owned failed-assistant omission before retry context, and the danger of using boundary continuations (which can bypass disabled retry). CI pins the exact supported SDK; only 1.0.0 was published/installed at validation.

## Live opt-in and bounded soak

`PI_GENERATION_RECOVERY_LIVE=1 npm run live` uses existing OAuth through Pi and temporary isolated state. It permits at most **32 requests / 600 seconds**, with at most three targeted opaque-state probes. Configure a suitable per-process network route; Node proxy routing needs `NODE_USE_ENV_PROXY=1`. No production session or pruning configuration is modified. Temporary data is removed in `finally`.

The test-only fetch body shim delegates OAuth, serialization, invocation and parsing to Pi. It waits for an authoritative completed encrypted reasoning item **and** Pi-normalized signed thinking completion **and** text generation before injecting the targeted local stream failure. No sleeps decide the cut. If the provider never exposes suitable state, it records that separately and exercises ordinary retry instead; it never promotes partial reasoning.

The tool guard allows only CodeBuffer create/read on the fixture buffer and the real pruning tool; generated code is never executed in the live soak. Deterministic fixtures also exercise a harmless CodeBuffer run through built-in CodeMode. Logging contains only sanitized categories/counters, never raw model contents, tool payloads, encrypted reasoning, credentials or headers.

The complete recorded soak passed: healthy long generation, CodeBuffer before/after, real pruning, native compaction before/after, one targeted **successful opaque state resume**, two repeated cuts bounded by the one-retry Pi budget, ordinary subsequent turn, session reopen and GC. See `validation-live.json` for exact counters. Earlier fixture attempts failed (network termination, assertion after compaction removed the last assistant, and a shorter time budget); they are not counted as successful soaks. The final fixture checks success before manual compaction.

One successful bounded soak is evidence, not a guarantee of every model/provider state or indefinite production stability. Live output quality and token economy are not benchmarked against a full-retry control.

## Separate local overhead measurements

- `npx tsx scripts/benchmark.ts`: journal serialization/hash/append/terminal sync only. Recorded 5000 frames, 1,338,890 bytes, 44.741 ms (8.948 microseconds/frame).
- `npx tsx scripts/benchmark-gc.ts`: 1000 inactive 2-KiB files, scan/stat/unlink only; fixture setup and model latency excluded. Recorded 93.000 ms, 2,048,000 bytes deleted, zero failures.

Hardware/filesystem results vary. Healthy provider requests remain equivalent, but capture and terminal sync have nonzero local overhead. Input/output/cache/reasoning usage are provider-reported counters, not estimates; failed streams may omit usage. Replayed bytes and exact duplicate bytes removed are not token savings.
