# PLAN — Live feed columns + `InspectorEnvelope`

Improve the Control Center **Live feed** with new columns (time, payload size, origin node,
request latency), plus text filter and sortable headers. The enabling change is a server-stamped
**`InspectorEnvelope`** that carries cross-cutting record-metadata around the (otherwise unchanged)
`InspectorEvent` union.

## Goal

Today each feed row is a flex pseudo-table (`packages/control-center/src/components/live-feed.tsx`):
`dot · type · summary · wire-chip · expand`. The `InspectorEvent` it renders carries **no timestamp
and no size** (`packages/core/src/inspector.ts:84`), and events are accumulated client-side in
`App.tsx:128` (`[event, ...prev].slice(0, 200)`, newest-first, live-only, no replay).

We want a real, scannable table with: **when** an event happened, **how big** its payload was, **which
node** emitted it, and **how long** a request took — plus filtering and sorting to hunt through the
200-event window.

## Decisions (locked during design review)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Data source for time/size | **Server-side**, stamped on the event path (not CC receipt-time) |
| 2 | `ts` placement | The **`emitInspectorEvent` choke point** (`server/src/index.ts:547`), origin-node `Date.now()` |
| 3 | `byteSize` meaning | **Snapshot-payload size**: `serializer.encode(payload).byteLength` of the already-redacted snapshot (not true wire bytes) |
| 4 | Field attachment | **Envelope** (`InspectorEnvelope`) — the union stays a pure "what happened" type; metadata lives in the wrapper |
| 5 | Feed layout | **Real `<table>`** modeled on `connections-table.tsx`; expandable payload as a `colSpan` row |
| 6 | Extra scope | text filter · sortable columns · origin-node column · latency |
| 7 | Latency computation | **CC-side pairing** of request↔response |
| 8 | Pairing key | Add **`reqId`** to the four message events; pair by `(connId, reqId)` |

### Why the envelope (decision 4)

`ts` / `byteSize` / `originNodeId` are facts about the *inspection record*, not about the domain
occurrence. Keeping them in a wrapper preserves `InspectorEvent` as a pure discriminated union and
matches the standard event-bus envelope shape (CloudEvents `time`/`source` around `data`, Kafka
headers around value). It also scales to future per-record metadata (sequence, trace id) without
reopening the union. `latencyMs` is *not* in the envelope — it's a fact about the response operation
and rides on the event member that has it.

### Known limitation (accepted)

`byteSize` is the **redacted snapshot** size. `safeSnapshot` (`server/src/index.ts:675`) redacts
fields, caps arrays at 1000 elements, and depth-limits — so a huge payload understates. This is
surfaced in a column tooltip, not engineered around. True wire bytes were considered and rejected
(transport-layer change; undefined for broadcasts/lifecycle).

## Type / contract changes — `packages/core/src/inspector.ts`

```ts
export interface InspectorEnvelope {
  event: InspectorEvent     // the union, shape otherwise unchanged
  ts: number                // origin-node emit time (Date.now() at the choke point)
  byteSize?: number         // encoded size of the redacted payload snapshot; absent for no-payload events
  originNodeId: string      // node that emitted it
}
```

- `events` topic payload: `s<InspectorEvent>()` → **`s<InspectorEnvelope>()`** (line 142).
- Add optional `reqId?: number` to **`msg.request`, `msg.response`, `msg.serverRequest`,
  `msg.serverReply`** (lines 92–101). Backward-compatible; no other member changes.
- **Lift `eventPayload`** from `control-center/src/lib/events.ts:141` into `inspector.ts` (it is the
  canonical "payload of this event" and the server now needs it for sizing). Export from
  `core/src/index.ts`. CC re-imports it.

## Server changes — `packages/server/src/index.ts`

All enrichment happens in the single choke point — **no changes to the ~25 emit call sites** except
adding `reqId` to the four that have it:

```ts
function emitInspectorEvent(event: InspectorEvent): void {
  if (!inspectorEnabled) return
  const payload = eventPayload(event)
  const envelope: InspectorEnvelope = {
    event,
    ts: Date.now(),
    originNodeId: instanceId,            // the server's own node id, already in scope (see line 1173)
    byteSize: payload === undefined ? undefined : serializer.encode(payload).byteLength,
  }
  void adapter.publish(INSPECT + 'events', serializer.encode({ t: 'pub', c: 'events', d: envelope }))
}
```

- `instanceId` / origin node id confirmed in scope (used at `index.ts:1173`). `serializer` confirmed
  in scope (used at `index.ts:549`). One extra payload-only encode per event, inspector-gated.
- Add `reqId`:
  - `handleReq` request + response emits (`index.ts:898`, `907`) → `reqId: frame.i`
  - error response in `dispatchOp` (`index.ts:877`) → `reqId: id`
  - `serverRequest` emit (`index.ts:1172`) → `reqId`
  - `serverReply` emit (`index.ts:510`) → its reqId (carried in scope where the reply is matched)

## Control Center changes

**Plumbing (envelope flows through):**
- `lib/inspector-client.ts`: `onEvent(cb: (env: InspectorEnvelope) => void)`; `frame.d as InspectorEnvelope` (line 100).
- `App.tsx`: `feed` state `InspectorEnvelope[]`; `setFeed` unchanged otherwise.
- `components/stores-explorer.tsx:55`: unwrap `env.event`.
- `lib/events.ts`: helpers keep taking `InspectorEvent` (callers pass `env.event`); import `eventPayload` from core; add `formatBytes` (3 lines).

**`components/live-feed.tsx` — the real work (modeled on `connections-table.tsx`):**
- Convert `<ul>/<li>` → real `<table>` with the house header style (uppercase, tracking-wide, muted).
- Columns: **type · summary · node · time · size · latency · wire**. Expandable payload = a second
  `<tr>` with `colSpan` shown under the clicked row.
- **time** = `formatTime(env.ts)` + muted `· formatDuration(env.ts)` (the exact `connections-table.tsx:63` pattern; re-renders when events flow, no timer).
- **size** = `formatBytes(env.byteSize)` or `—` for no-payload events; tooltip notes "redacted snapshot size".
- **node** = `resolver.nodeName(env.originNodeId)`.
- **latency** = one render-pass builds `Map<` `connId|reqId` `, ts>` over the shown rows; response/reply
  rows display `response.ts − request.ts` ms; everything else `—`. Unknown (→ `—`) if the request
  aged past the 200-cap. Req/res pair is same-node, so the two `ts` share one clock.
- **Text filter**: a search `<input>` beside the category toggles; substring match on type + summary.
- **Sortable headers**: click to sort (size-desc is the headline). Sorting only applies to the
  **frozen snapshot when Paused** (existing Pause already freezes), since sort fights live newest-first.

## Slices (TDD; each leaves root `pnpm typecheck` + `pnpm test` green)

1. **Envelope on the wire** — core (`InspectorEnvelope`, lift `eventPayload`, topic payload type) +
   server (choke-point enrichment) + CC plumbing (onEvent/feed/stores-explorer/live-feed read
   `env.event`, no new columns yet). *Test:* server emits envelope; `ts`/`originNodeId` present;
   `byteSize` present for payload events, absent for lifecycle.
2. **`reqId` correlation** — core (4 members) + server (4 emit sites). *Test:* request/response carry
   matching `reqId`; two same-name in-flight requests get distinct ids.
3. **Real table + time/size/node columns** — convert `live-feed.tsx`; add `formatBytes`. *Test:*
   `formatBytes`; no-payload → `—`.
4. **Latency column** — CC pairing pass. *Test:* correct pairing under same-name concurrency; `—`
   when request past cap.
5. **Text filter** — input + filter. *Test:* substring filters rows.
6. **Sortable headers** — sort state; sort-while-paused. *Test:* size-desc orders the frozen snapshot.

Slices 1→2 are protocol; 3–6 are CC-only and independently reviewable.

## Test plan

- **core**: `InspectorEnvelope` compiles; `events` topic typed as envelope; `eventPayload` parity after move.
- **server** (`test/harness.ts` reads `frame.d`, currently `InspectorEventLike`): assert envelope
  fields; `byteSize` semantics; `reqId` matching on pairs.
- **control-center**: `formatBytes`; pairing under concurrency; sort-while-paused.

## Risks / consequences

- **Public type change** in `core`, `server`, `control-center` → version bumps + republish. Per
  standing rule: **ask before publishing.**
- **Bus frame shape changes** (`d` is now an envelope) → node and CC images want a matched rebuild;
  a new CC talking to an old server (or vice versa) will mis-read the feed. Single-version cluster only.
- `server/test/harness.ts:60` `InspectorEventLike` is decoupled, so existing assertions don't break;
  new assertions read the envelope.

## Out of scope (deliberately)

- True wire-byte sizing (transport-layer change; rejected — see Known limitation).
- Server-side latency measurement (decision 7 chose CC-side pairing).
- Feed replay/backfill on reconnect — feed stays live-only, 200-cap.

## As-built / Status (2026-06-29)

**SHIPPED to `origin/main`** (`8618d65` `chore(release): core/server 0.7.1, control-center 0.7.0`,
on the back of `5113c4a`/`8fd4cba`/`b4211db`). `InspectorEnvelope` (`ts`/`byteSize`/`originNodeId`) on the
`events` topic, `reqId` correlation on the four message events, and the real `<table>` live feed with
time/size/node/latency columns + text filter + sortable-while-paused headers all landed and are published
(core/server 0.7.1, control-center 0.7.0). Out-of-scope items above remain deferred.
