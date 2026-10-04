# Compatibility

## Current baseline

Node >=24; tested floor **Pi coding-agent and pi-ai 1.0.2**. Pi peer versions are unrestricted (`*`); runtime checks required APIs, not version labels. CI/dev dependencies pin 1.0.2 for reproducibility only. Users may upgrade independently, including minor/major releases; absence of a version gate is not a compatibility guarantee. Historical validation JSON files describe earlier releases, not current support.

A future baseline change requires public SDK retry/omission, healthy-equivalence, unsafe-tail, chained-recovery and installed-artifact regressions before changing peers and the guard. No private Pi imports or monkey patches. Pi remains the sole retry owner.

Linux is the validated daily-driver platform. Automatic GC uses descriptor-anchored Linux filesystem operations; other platforms fail closed for GC and need manual retention. Node 24.21.0 is the local baseline; CI uses Node 24.

## Companion packages

Development fixtures use the maintained, unversioned Git sources for pi-codebuffer, pi-codex-native-compaction and pi-context-prune. The lockfile records the tested revisions; production recovery imports none of these companions. No upstream pruner npm fallback or old release-asset fixtures are used.

The matrix covers recovery alone, each companion and combined/reversed orders. Assertions cover CodeBuffer revisions, no repeated tool execution, native checkpoints, pruning boundaries, canonical future requests and session reopen without automatic requests. A new pruning context mutation during a failed generation makes recovery stale and causes a safe fallback.

Native compaction remains the compaction/provider-wrapper owner. Recovery does not register a provider, intercept before_provider_request, or own retry scheduling. Completed reasoning can be retained; incomplete reasoning and tool actions are never replayed. Journals are not automatically resumed after restart.
