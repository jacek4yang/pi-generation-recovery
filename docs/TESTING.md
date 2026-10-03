# Testing

```sh
npm ci --no-audit --no-fund
npm run check
npm run format:check
npm pack --json
npm run smoke
```

`check` runs strict TypeScript, ESLint and deterministic Node tests. Tests use the actual Pi 1.0.0 SDK and Codex Responses provider with a local HTTP/SSE fault server and fake isolated credentials. No live credentials are required. The packaged smoke installs the actual tarball into a temporary environment and runs the same SDK suite against installed source, including the optional companion matrix.

Coverage includes healthy request equivalence, disabled/exhausted retries, no output, incomplete/complete reasoning, long Unicode/Markdown prefixes, semantic continuation, partial tools, repeated interruption, abort/non-retryable failures, canonical future requests, branch/model/tool changes, headroom, disk errors, corruption/truncation, child-process abrupt exit, observer privacy, source loading, companion state and extension ordering. See executable tests for precise assertions rather than treating scenario names as guarantees.

## Live opt-in

`PI_GENERATION_RECOVERY_LIVE=1 npm run live` uses existing OAuth via Pi, temporary sessions, all three plugins, at most 16 requests and a 180-second budget. Configure an appropriate per-process network route; Node proxy routing needs `NODE_USE_ENV_PROXY=1`. Never run this against a production session. The test-only interruption shim delegates requests/auth/serialization to Pi and interrupts a response locally. It is not a production transport implementation. Logs contain only sanitized counters/categories.

Recorded validation: healthy Codex generation, successful CodeBuffer create/read, native compaction, controlled local text interruption and reopen passed in 8 requests with 2 CodeBuffer operations. The live provider supplied **no completed opaque reasoning before the cut**, so Pi correctly used ordinary retry (`stateResume: 0`). Live opaque-state replay is not claimed; deterministic real-provider-path fixtures demonstrate that path. See `validation-live.json`.

## Performance and metrics

`npx tsx scripts/benchmark.ts` measures only journal append/hash/flush/sync overhead, not model or whole-extension latency. One local 5000-record run took 46.155 ms (9.231 microseconds/record), writing 1,338,890 bytes. Hardware/filesystem results vary. Healthy requests are asserted equivalent; there is no claim of literally zero overhead.

Reported usage is distinct from byte counters. Interrupted streams may omit usage, and input replay itself costs tokens. The deterministic fixture measures preservation/continuation correctness, not subjective live completion quality or guaranteed billing savings.
