# Failure model

| Condition                                               | Safe response                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| EOF/network error before work                           | Pi retry, unchanged budget/backoff                                     |
| Incomplete reasoning, even with useful summary          | Full Pi retry                                                          |
| Completed exposed opaque reasoning and interrupted text | Replay compatible state and complete prefix on authorized retry        |
| Pure-text Codex model, substantial prefix               | Semantic continuation on authorized retry                              |
| Partial or complete tool in failed attempt              | Refuse inference recovery; Pi owns tools/retry                         |
| Abort or non-retryable error                            | Capture diagnostics; no extra request                                  |
| Repeated eligible interruption                          | Chain safe text state, bounded by Pi retry budget and storage/headroom |
| Context overflow                                        | No independent request/compaction; Pi policy applies                   |
| Changed branch/model/system/tools/thinking/session      | Reject stale checkpoint                                                |
| Missing/corrupt/oversize journal or failed write        | No replay; previously committed records remain diagnostic              |
| Crash/truncated last record                             | Validate committed prefix; no automatic restart request                |
| Insufficient context headroom                           | Full Pi retry, no recovery/compaction cycle                            |

Hash chaining detects corruption, not a malicious local user able to rewrite both journals and session metadata. Filesystem permissions are defense in depth, not encryption. Opaque reasoning is provider-encrypted state already exposed to Pi; the extension does not decrypt it.

Generation journals are not execution journals. Exactly-once remote side effects cannot be guaranteed by an inference extension. Recovery never executes tool arguments or replays a tool turn.

State-preserving resume does not recreate provider-hidden state that was never received. The continuation remains a new model request and may differ in output or quality. Exact overlap removal is intentionally conservative and may leave duplicate text.
