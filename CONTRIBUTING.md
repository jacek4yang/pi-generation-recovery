# Contributing

Use Node 24+ and the lockfile. Run `npm ci --no-audit --no-fund`, `npm run check`, `npm run format:check`, `npm pack --json` and `npm run smoke` before opening a PR. Format with `npm run format`. No credentials are needed for deterministic tests.

Keep provider-specific policy in adapters. Add deterministic faults and real SDK regressions for lifecycle changes. Never add provider/auth/transport ownership, compaction, tool execution replay, companion runtime imports or recovery via `before_provider_request`. Preserve other extensions’ session entries and all package load orders.

Use a feature branch and PR; protected main requires the strict `verify` check, resolved conversations and squash merge. Do not bypass protections. Security issues belong in private advisories, not public logs. See [security](SECURITY.md), [testing](docs/TESTING.md) and [releasing](docs/RELEASING.md).
