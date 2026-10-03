# Compatibility

## Exact Pi baseline

Node >=24; **Pi coding-agent and pi-ai exactly 1.0.0**. At the 2026-10-03 registry audit, 1.0.0 was simultaneously the minimum supported version, the installed daily-use version, and the newest published version of these renamed packages. The registry returned only this version. CI pins `1.0.0` explicitly; it does not use `latest` or pretend three aliases are three different tested versions. See `validation-versions.json`.

Peer dependencies and the public-entry `VERSION` guard reject untested Pi versions. To expand support, add exact matrix versions and rerun the public SDK retry/omission, healthy-equivalence and installed-artifact tests before widening peers/guard. No pre-1.0 compatibility. No private imports or monkey patches.

Linux is the validated daily-driver platform. Automatic GC uses descriptor-anchored Linux filesystem operations; other platforms fail closed for GC and need manual retention. Node 24.21.0 was used locally; CI uses Node 24.

## Actual companion packages

| Companion                  | Verified version/source                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| pi-codebuffer              | v0.1.0, commit `e46b4b33e592b7ff5bc8681399937646ce6d1cb3`                  |
| pi-codex-native-compaction | v0.3.2 release artifact, commit `eb8eb89617030b30de322afec12d1fafb778b31d` |
| pi-context-prune           | npm 2.1.0, https://github.com/championswimmer/pi-context-prune             |

The pruning package was identified from the user’s actual installed package/settings, not guessed. Its public entry and real summarization/context hooks run in isolated tests, with deterministic local provider responses; no private dependency or substitute pruning implementation is needed. Production recovery imports no companion. All are optional pinned dev fixtures. Companion repositories remain untouched.

The eight-case original matrix covers recovery alone, each original companion and all three in reversed package orders. Six additional tests exercise the complete four-plugin stack in four relevant orders, and failed-generation pruning in both recovery/pruner orders. Built-in CodeMode is registered after package extensions, as required by its normal Pi loading contract.

Assertions cover successful CodeBuffer operations and durable revisions, no repeated tool action across recovery, unchanged previously owned companion entries, native checkpoints before/after, pruning summaries/frontiers, canonical future requests and session reopen without an automatic request. Already committed pruning is compatible. Pruning that writes new context state during the failed generation makes recovery stale and safely falls back, regardless of hook order. Recovery does not try to reinterpret arbitrary third-party transformations.

Native compaction remains the only compaction/provider-wrapper owner. Recovery uses no provider registration, `session_before_compact`, or `before_provider_request`. Empty pending canonical markers defer incompatible snapshots; successful recovery clears them without permanent fake user messages. Pi owns retry budget/backoff/authorization. Recovery touches only its own bookkeeping and the supported replacement of its current successful assistant.
