# Architecture

## Ownership and public API

The extension captures Pi-normalized `AssistantMessageFrame` records with the public `AssistantMessageFrameEncoder` and reconstructs them with `reduceAssistantMessageFrames`. The journal envelope supplies sequence numbers and a hash chain, not a second stream protocol. No provider serializer, auth, transport or runtime internals are imported.

`GenerationCheckpoint` binds session, branch head, user source, turn and attempt to provider/API/model, thinking level, system prompt hash and tool-loadout hash. Pi custom entries under `pi-generation-recovery.v1` contain bounded metadata and journal references; high-frequency frames live outside session JSONL. Completed reasoning signatures are opaque.

The frontier distinguishes absent work, partial/complete reasoning, text and tool items, and terminal completion. The Codex adapter requires both authoritative `response.output_item.done` reasoning metadata and normalized completed signed thinking blocks. Summary deltas alone are insufficient. `provider_stream_event` is an allowlisted read-only in-memory observer.

## Retry authorization and ordering

Verified against the actual Pi 1.0.0 SDK:

1. `message_start` / `message_update` capture normalized frames; provider events independently establish authoritative completion.
2. `message_end` flushes the journal and records metadata **before assistant persistence**. An eligible interruption queues an empty hidden custom message with `triggerTurn: false`.
3. `turn_end` sees the persisted failed assistant ID and pending message. The pending state makes native compaction defer regardless of extension load order.
4. Extension `agent_end` does not expose the subsequent retry decision. Pi checks retry settings/budget and persists a null `context_edit` for the exact failed assistant before retry.
5. Only a subsequent `context` event containing that persisted omission authorizes recovery injection. No omission, no replay. No boundary continuation is requested.
6. Before replay, identity and conservative headroom are revalidated; journal hashes and frame count must match. The reconstructed assistant prefix and explicit continuation instruction pass through Pi canonical serialization.
7. On success, `message_end` replaces the completion with the combined canonical assistant before persistence. The transient instruction was never a permanent session message. Owned empty markers are omitted at `turn_end` / `agent_before_settle`. Existing boundary drafts are preserved.
8. `agent_before_settle` clears unresolved recovery after Pi declines further retries. `agent_settled` needs no intervention. Native compaction becomes eligible again with canonical context.

Pi extensions cannot read the internal retry-decision flag at `agent_end`. Tests demonstrate that boundary continuations would incorrectly bypass disabled retry. Durable failed-attempt omission is therefore the narrow public authorization mechanism; regression tests guard this Pi 1.0 behavior. A future upstream `before_auto_retry` event could make authorization explicit.

## Canonicalization and side effects

Failed assistant omission is owned by Pi. Recovery edits only its own markers and replaces the exact current successful assistant via the supported event result. It never edits another plugin entry. Empty custom content serializes to zero Responses items, including when another boundary handler sees it before cleanup.

Any tool content in an interrupted attempt prohibits replay. Previously completed tool turns remain in the canonical transcript. New complete tool calls in a recovered successful generation remain Pi-owned. Text merge uses bounded exact overlap (maximum 8192 UTF-16 units, minimum 32, diverse characters, surrogate-safe); no semantic deletion.

## Strategy and extensibility

Capabilities separate native cursor resume, opaque reasoning replay, completed items, assistant prefixes and tool replay. Native resume is currently unavailable; tools are never replayable. The adapter factory is the only API-specific decision point. Unsupported APIs capture only. State resume outranks semantic continuation; ordinary Pi retry is the safe fallback.

Headroom counts replay bytes conservatively as tokens plus reserve. Unknown post-compaction usage falls back to the entire persisted branch byte size, including opaque native state, system and tools. Recovery never requests compaction to make recovery fit.

## Storage cost

Journal writes are asynchronous, batched (64 KiB/250 ms), bounded to 1 MiB pending and 32 MiB per attempt, with terminal flush/sync, not per-token fsync. Frame capture, hashing and one terminal sync have a real nonzero cost; no network path changes on healthy requests. Failures disable recovery, not generation. No automatic old-journal garbage collection.
