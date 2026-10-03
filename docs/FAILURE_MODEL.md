# Failure model

| Condition                                                    | Safe response                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| EOF/network error before work                                | Pi retry, unchanged budget/backoff                                                                                          |
| Incomplete reasoning, even with useful summary               | Drop that item and its suffix; recover only an earlier verified prefix, otherwise full retry                                |
| Completed exposed opaque reasoning, including reasoning-only | Replay compatible safe prefix on Pi-authorized retry                                                                        |
| Pure-text Codex model, substantial prefix                    | Semantic continuation on authorized retry                                                                                   |
| Partial or complete tool in failed attempt                   | Drop the tool and suffix; preserve eligible earlier state. Never execute, reconstruct or replay that tool                   |
| Abort or non-retryable error                                 | Capture diagnostics; no extra request                                                                                       |
| Repeated eligible interruption                               | Chain prior safe state plus newly completed items across text/reasoning/tool tails, bounded by Pi retry budget and headroom |
| Context overflow                                             | No independent request/compaction; Pi policy applies                                                                        |
| Changed branch/model/system/tools/thinking/session           | Reject stale checkpoint                                                                                                     |
| Missing/corrupt/oversize journal or failed write             | No replay; previously committed records remain diagnostic                                                                   |
| Crash/truncated last record                                  | Validate committed prefix; no automatic restart request                                                                     |
| Insufficient context headroom                                | Full Pi retry, no recovery/compaction cycle                                                                                 |

Hash chaining detects corruption, not a malicious local user able to rewrite both journals and session metadata. Filesystem permissions are defense in depth, not encryption. Opaque reasoning is provider-encrypted state already exposed to Pi; the extension does not decrypt it.

Generation journals are not execution journals. Exactly-once remote side effects cannot be guaranteed by an inference extension. Recovery never executes tool arguments or replays a tool turn.

State-preserving resume does not recreate provider-hidden state that was never received. The continuation remains a new model request and may differ in output or quality. Exact overlap removal is intentionally conservative and may leave duplicate text.
