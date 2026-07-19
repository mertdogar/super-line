# ADR-0011: Streamed messages are parts-rows plus ephemeral deltas

**Status:** accepted (2026-07-16), amended (2026-07-19) · **Builds on:** ADR-0010

## Context

Agent runtimes need a chat message that stores an **entire streaming turn** — reasoning, tool
calls (nested subagent trees included), text — accumulated live and rendered richly. super-harness
proved the ephemeral-preview model but deferred its known hole: a client reloading mid-turn sees
empty text until the turn settles, because deltas are never persisted and the durable row is only
written at the end. plugin-chat fixes this in the wire layer, as a generic primitive any producer
can drive.

Two physics facts shape everything:

1. A collection row update fans out the **whole post-op row**. One row holding a growing turn is
   O(turn²) on the wire — every checkpoint re-sends everything accumulated.
2. super-line topics are **fixed-name, role-wide** feeds with no per-connection scoping. A global
   `chat.stream` topic would broadcast private-channel deltas to every subscriber.

## Decision

**Storage: parts-as-rows.** A `chat.messageParts` collection, keyed `${messageId}:${idx}`, one row
per block (`text` · `reasoning` · `tool` · host-typed `data`); the message row is a thin envelope (`status`, `error?`,
final `content` projection — `content` became optional and stays absent until finalize). Rewrite
cost is bounded by part size; settled parts are free, natural checkpoints. Subagent trees need only
`parent?: string` (the delegating tool part's `toolCallId`) — one message = one whole turn-tree.

**Wire: three requests + a plugin-owned event union.** `startMessage` / `appendMessage` (batched
`part_start`/`delta`/`tool_patch`/`data_patch`/`part_end`, producer part-keys, server-assigned idx) /
`finalizeMessage` plus an explicit `cancelMessage` request — requests-first per ADR-0010, hookable at start/finalize only (hooks gate
INTENT; forced aborts — disconnect, kill-switch, cap violations, shutdown drain — are unvetoable).
The union is deliberately NOT AI SDK `UIMessageChunk`: adapters (`pipeUIMessageStream` in `/ai-sdk`)
absorb SDK drift at the edge, the wire schema stays ours.

**Deltas: per-channel rooms, checkpoints as the floor.** Token deltas broadcast ephemerally to a
room entered via `watchChannel` (membership-authorized; rooms ride the adapter cluster-wide —
topics lost on privacy). The in-flight part's row checkpoints ~1s with accumulated text + `offset`;
deltas carry `(messageId, partIdx, offset, text)`. A late joiner reconstructs from rows alone and
splices live deltas by offset — a lost delta degrades smoothness for ≤1s, never correctness. A
crash leaves a readable partial message.

**Lifecycle: disconnect-abort, no timers.** The starting connection owns a client stream's
lifetime; disconnect settles it `aborted` with partials preserved. Staleness is visible
(`lastActivityAt`); repair is host-invoked (`sweepStale`) because on a cluster only the host knows
whether another node's stream is live. Graceful `server.close()` drains open streams via an awaited
plugin dispose.

**Read side: envelopes, history, and complete per-message parts.** `chatClient.messages()` is a
bounded live newest-N envelope window. `history()` is one-shot keyset pagination for older
envelopes. `messageParts(channelId, messageId)` is complete for one selected message, tree-ordered,
and owns its delta-room overlay. This avoids loading channel-wide parts without silently truncating
the detailed transcript of an old or very large turn.

## Consequences

- Every viewer path (live, late-join, reload, reconnect, crash) converges on the same rows; the
  ephemeral layer is pure smoothness.
- The plugin owns the structural vocabulary while hosts parameterize `data` payloads with a contract
  schema. SDK-specific file/source/usage chunks are interpreted by optional adapter mappings.
- Hosts with a structured `content` schema must supply `streaming.project` to derive the envelope
  projection (the default text-join fails loudly with guidance).
- Cross-node: appends must reach the ingress node that owns the stream state (they do — same
  authoring connection); relay-cluster lock caveats from ADR-0010 apply unchanged.
