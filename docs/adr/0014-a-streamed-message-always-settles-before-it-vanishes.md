# ADR-0014: A streamed message always settles before it vanishes

**Status:** accepted (2026-07-19), reverses a deliberate 0.5.0 choice · **Builds on:** ADR-0011 ·
**Prompted by:** the OMMA 0.5.0 adoption findings (findings 3+4)

## Context

Through 0.5.0, deleting a still-streaming message dropped the local stream **without settle
writes** — "the rows go away" — a deliberate choice (delete is delete; why write to rows about to
vanish?). Real-consumer usage showed the two costs of that shortcut, one per side of the wire:

- **Producer:** the client's per-message stream-handle registry cleans up only on the settle path
  (`finalize`/`abort`/cancel signal). A producer that deletes its own streaming row — OMMA does
  this deliberately for empty turns — strands the handle for the client's lifetime; the documented
  workaround was a delete-then-`abort().catch()` recipe every host must know.
- **Consumer:** a deleted streaming row emits **no terminal status**, so any fold gating "turn
  finished" on reaching a non-`streaming` status wedges forever. OMMA's harness had exactly this
  bug and had to synthesize the boundary when the active message vanished from the feed.

Both are one missing invariant, and no client-side patch closes it for deletes initiated by *other*
members or *other* nodes.

## Decision

**Deletion of a streaming message settles it first, server-side.** `deleteMessage` on a
`status: 'streaming'` row:

1. emits the existing `chat.streamCancelled` signal to the author (cluster-wide, `toUser`) — the
   producer's stream handle releases and `writer.signal` aborts the model run, whoever deleted;
2. settles via the unvetoable `forceAbort` path (`aborted`, reason `deleted`) when the stream is
   local — consumers observe a terminal status **before** the rows disappear; when the stream lives
   on another node, the terminal status is written directly and that node's own settle later no-ops
   via `settle`'s deleted-row guard;
3. then deletes the message and its parts as before.

`deleteChannel` follows the same rule for every still-streaming message in the cascade: producers
are signalled (reason `channel deleted`) and local streams settle through `forceAbort` (rows are
already gone — settle takes its no-write path, but `finalizeMessage.after` still fires so audit
never misses an interrupted turn).

## Consequences

- Consumers may treat `status !== 'streaming'` as a reliable turn boundary; disappearance without a
  prior terminal status can no longer happen. OMMA's boundary-synthesis and delete-then-abort
  workarounds become dead code.
- A deleted streaming row briefly costs settle writes (status + projection) that are removed
  microseconds later — accepted to keep exactly one settle path.
- `finalize({ deleteIfEmpty })`-style sugar is subsumed: a raw delete is now safe mid-stream.
- On channel deletion the terminal status is not observable (the whole channel's rows vanish
  wholesale); the invariant there protects the producer side only.
