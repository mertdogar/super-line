# PLAN — surface the transport (wire) dimension in the Control Center

Agreed via grill-me (2026-06-23). Goal: show which client↔server **transport** (WebSocket / HTTP·SSE / HTTP·long-poll /
libp2p / loopback) each connection uses, as a **first-class dimension** in the Control Center — column, topology
tint + per-node breakdown, a Transports highlight lens, and live-feed wire attribution.

## Decisions
- **Scope:** first-class dimension (treated like `role` is today).
- **Granularity:** group by 4 families `{websocket, http, libp2p, loopback}`; HTTP keeps its sub-mode (`sse`/`longpoll`)
  as secondary detail. Data stores the exact wire literal.
- **Feed:** resolve push targets too (broadcast → room members' wires, directed event → target conn's wire).

## Key facts that shape the plan
- The wire lives only in `Handshake.transport` (`core/src/transport.ts:33`); each transport sets a literal:
  WS `'websocket'`, libp2p `'libp2p'`, loopback `'loopback'`, HTTP `'sse'` **or** `'longpoll'` (no umbrella `'http'`).
- It is dropped at `authHook` (`server/src/index.ts:663`), which returns only `{role, ctx}`.
- **One field threaded once** reaches everything: `AuthOutcome.transport` → `Conn.transport` → `buildDescriptor` →
  `ConnDescriptor.transport`. `ConnDescriptor` flows cluster-wide via `PresenceStore` AND is embedded in the
  `connect` inspector event, so all CC surfacing is **client-side derivation** from data the CC already holds
  (`connections: ConnDescriptor[]`). No inspector-protocol/`InspectorEvent` change needed.
- Blast radius checks: only **one** `new Conn(` call site (`index.ts:679`); `AuthOutcome` is built as `{role,ctx}`
  literals in 4 transport test files → make the new field **optional** to avoid test churn (authHook always sets it).
- The CC bundles `@super-line/core` from source (vite alias), so a core type change reaches the CC with no publish.

---

# Phase 1 — Server plumbing (the one field)

### 1. `packages/core/src/transport.ts:45` — add `transport?` to `AuthOutcome`
```diff
-/** What `authenticate` returns. Reject by throwing — the transport then rejects in its native idiom. */
-export type AuthOutcome = { role: string; ctx: unknown }
+/** What `authenticate` returns. Reject by throwing — the transport then rejects in its native idiom.
+ *  `transport` is injected by the server (from `Handshake.transport`); user `authenticate` callbacks don't set it. */
+export type AuthOutcome = { role: string; ctx: unknown; transport?: string }
```
Optional ⇒ the `{ role, ctx }` literals in `transport-{websocket,http,libp2p,loopback}` tests still typecheck.

### 2. `packages/core/src/adapter.ts:43-46` — add `transport?` to `ConnDescriptor`
```diff
   /** Room memberships (topics and node-local `lastPongAt` are not included). */
   rooms: string[]
+  /** The client↔server transport (wire) this conn was accepted on:
+   *  `'websocket' | 'sse' | 'longpoll' | 'libp2p' | 'loopback'`. Absent on conns from older nodes. */
+  transport?: string
   /** Extra fields contributed by the server's `describeConn` hook. */
   [extra: string]: unknown
```

### 3. `packages/server/src/conn.ts` — add a `transport` field to `Conn`
Add a public field next to `data` (set once at accept; mirrors the existing mutable-field convention — smallest change,
no constructor reshuffle):
```diff
   /** Mutable per-connection scratch state, typed per role by the contract's `data` schema. */
   data: Data = {} as Data
+  /** The client↔server transport (wire) this connection was accepted on (set by the server at accept). */
+  transport?: string
```
*(Alternative: a `readonly` constructor param after `ctx` — stricter immutability, but reshuffles the single
`new Conn(` call site. Not worth it for a value set exactly once.)*

### 4. `packages/server/src/index.ts:663-666` — `authHook` carries the wire
```diff
   const authHook = async (handshake: Handshake): Promise<AuthOutcome> => {
     const auth = await opts.authenticate(handshake)
-    return { role: auth.role, ctx: auth.ctx }
+    return { role: auth.role, ctx: auth.ctx, transport: handshake.transport }
   }
```

### 5. `packages/server/src/index.ts:679-689` — `acceptConn` sets it on the Conn
Right after the `const conn = new Conn(...)` block (before the inspector branch):
```diff
       : undefined,
     )
+    conn.transport = auth.transport
     raw.onMessage((bytes) => {
```
(Harmless for inspector conns, which return early and never build a descriptor.)

### 6. `packages/server/src/index.ts:344-358` — `buildDescriptor` includes it
```diff
       ...(userId !== undefined ? { userId } : {}),
       rooms,
+      ...(conn.transport !== undefined ? { transport: conn.transport } : {}),
       ...opts.describeConn?.(conn),
```
Conditional spread keeps `transport: undefined` out of the snapshot. Placed among the core fields (before
`describeConn`).

### 7. Test — `packages/server/test/transport-identity.integration.test.ts` (new)
Self-contained, deterministic via the loopback transport pair (`createLoopbackTransport()` → `{ server, client() }`):
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'

const contract = defineContract({
  shared: { clientToServer: { ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) } } },
  roles: { user: {} },
})

describe('transport identity', () => {
  it('threads the wire onto conn.transport and the descriptor', async () => {
    const loopback = createLoopbackTransport()
    let seen: string | undefined
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (conn) => { seen = conn.transport },          // Conn field
    })
    srv.implement({ shared: { ping: async () => ({ ok: true }) } })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    await client.ping({})                                         // ensure the conn is accepted
    expect(seen).toBe('loopback')
    // stronger, end-to-end (what the inspector serves): assert the cluster descriptor carries it
    const [d] = await srv.cluster.list()                          // presence-backed; in-memory adapter has it
    expect(d?.transport).toBe('loopback')
    await srv.stop?.()
  })
})
```
*(If `srv.cluster.list()` isn't the exact public surface, fall back to the `onConnection` assertion alone, or assert
through an inspector `listConnections()` over a second loopback dial — confirm against the existing
`packages/server/test/harness.js` helpers when implementing.)*

**Phase-1 gate:** `pnpm typecheck && pnpm test` (root). The 4 transport test files keep compiling (optional field).

---

# Phase 2 — Control Center structural (client-side, no further server change)

### 8. `packages/control-center/src/lib/transport.ts` (new) — the wire helpers (mirror `roleColor`)
```ts
export type TransportFamily = 'websocket' | 'http' | 'libp2p' | 'loopback' | 'unknown'

export function transportFamily(t: string | undefined): TransportFamily {
  switch (t) {
    case 'websocket': return 'websocket'
    case 'sse': case 'longpoll': return 'http'
    case 'libp2p': return 'libp2p'
    case 'loopback': return 'loopback'
    default: return 'unknown'
  }
}
export function transportLabel(t: string | undefined): string {
  switch (t) {
    case 'websocket': return 'WebSocket'
    case 'sse': return 'HTTP · SSE'
    case 'longpoll': return 'HTTP · long-poll'
    case 'libp2p': return 'libp2p'
    case 'loopback': return 'Loopback'
    case undefined: return 'unknown'
    default: return t
  }
}
export function familyShort(f: TransportFamily): string {
  return f === 'websocket' ? 'ws' : f          // 'ws' | 'http' | 'libp2p' | 'loopback' | 'unknown'
}
const TRANSPORT_COLORS: Record<TransportFamily, string> = {
  websocket: '#22d3ee', http: '#a78bfa', libp2p: '#34d399', loopback: '#64748b', unknown: '#64748b',
}
export function transportColor(t: string | undefined): string {
  return TRANSPORT_COLORS[transportFamily(t)]
}
/** Families present across connections, with counts (for the lens + breakdown). */
export function transportsOf(conns: { transport?: string }[]): { family: TransportFamily; count: number }[] {
  const m = new Map<TransportFamily, number>()
  for (const c of conns) { const f = transportFamily(c.transport); m.set(f, (m.get(f) ?? 0) + 1) }
  return [...m.entries()].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count)
}
/** "3 ws / 2 http" for a node's connection list. */
export function breakdownLabel(conns: { transport?: string }[]): string {
  return transportsOf(conns).map(({ family, count }) => `${count} ${familyShort(family)}`).join(' / ')
}
```

### 9. `packages/control-center/src/components/connections-table.tsx` — add a `transport` column
- Import: `import { transportColor, transportLabel } from '@/lib/transport'`.
- New `<th>transport</th>` after the `role` th (line 24).
- New `<td>` after the role `<td>` (line 47):
```tsx
<td className="px-3 py-2">
  <span className="inline-flex items-center gap-1.5">
    <span className="h-2 w-2 rounded-full" style={{ background: transportColor(c.transport) }} />
    {transportLabel(c.transport)}
  </span>
</td>
```

### 10. `packages/control-center/src/components/conn-detail.tsx` — header line (JSON dump already shows it)
- Import `transportLabel`. Append to the summary line (lines 62-65): `· over {transportLabel(view.descriptor.transport)}`.
- The `<Json data={view.descriptor}>` block already renders the new `transport` field automatically.

### 11. `packages/control-center/src/lib/topology.ts` — carry wire on nodes + per-node breakdown
- `GraphNode` gains (after `rooms?`):
```diff
   rooms?: string[]
+  transport?: string        // conn nodes
+  breakdown?: string        // server nodes: "3 ws / 2 http"
```
- In `buildGraph`, server node push (lines 90-98): add `breakdown: breakdownLabel(connsByNode.get(sid) ?? [])`.
- Conn node push (lines 104-113): add `transport: c.transport`.
- Import `breakdownLabel` from `./transport`. (Re-export `transportsOf` here too if you prefer one import site —
  optional.)

### 12. `packages/control-center/src/components/topology-graph.tsx` — tint conns by wire + per-node summary + generalized highlight
- Import `transportColor, transportFamily` from `@/lib/transport`.
- `labelFor` server branch (lines 10-17): add the breakdown under the conn count:
  `{n.connCount} conns · {n.breakdown}{n.alive ? '' : ' · dead'}`.
- `styleFor` conn branch (lines 52-62): tint by **wire** instead of role:
  `const color = transportColor(n.transport)` (role stays visible as the node's text label).
- Generalize the highlight (see #13): replace the `highlightRoom: string | null` prop with
  `highlight: { kind: 'room' | 'transport'; value: string } | null`, and compute dim/ring for both kinds:
```ts
const dim = highlight !== null && n.kind === 'conn' && !matchesHighlight(n, highlight)
// matchesHighlight: kind==='room' ? n.rooms?.includes(value) : transportFamily(n.transport) === value
```

### 13. `App.tsx` + `room-lens.tsx` — Transports lens section + generalized highlight (the one refactor)
**`App.tsx`:**
- Replace `const [highlightRoom, setHighlightRoom] = useState<string | null>(null)` with
  `const [highlight, setHighlight] = useState<{ kind: 'room' | 'transport'; value: string } | null>(null)`.
- Add `const transports = React.useMemo(() => transportsOf(connections), [connections])`
  (import `transportsOf` from `@/lib/transport`).
- Pass `highlight` to `<TopologyGraph>` (replacing `highlightRoom`), and `transports` + `selected={highlight}` +
  `onSelect={setHighlight}` to `<RoomLens>`.

**`room-lens.tsx`:**
- Props: add `transports: { family: TransportFamily; count: number }[]`; change `selected`/`onSelect` to the
  `{ kind, value } | null` shape.
- New `<Section title="Transports · highlight">` (between Roles and Rooms) listing each family as a button:
  color dot via `transportColor`, label via `familyShort` + count, selected when
  `selected?.kind === 'transport' && selected.value === family`; click toggles
  `onSelect({ kind: 'transport', value: family })`.
- Rooms buttons now emit `{ kind: 'room', value: room }` (compare on `selected?.kind === 'room'`).
- Roles section stays a legend (role highlight wasn't requested).

*(Alternative to generalizing: keep `highlightRoom` and add a parallel `highlightTransport` state. The
`{kind,value}` union is cleaner — one highlight at a time — and is the recommendation.)*

**Phase-2 gate:** `pnpm --filter @super-line/control-center build` + `pnpm typecheck`. Add helper unit tests
(`packages/control-center/test/transport.test.ts`): `transportFamily`/`transportLabel`/`transportColor`/`transportsOf`/
`breakdownLabel`. Extend `topology.test.ts` to assert `buildGraph` sets `transport`/`breakdown`.

---

# Phase 3 — Live-feed wire attribution (the "resolve push targets" steer)

### 14. `packages/control-center/src/lib/events.ts` — attribution helper + resolver extension
- Extend `FeedResolver`:
```diff
 export interface FeedResolver {
   conn(connId: string): ConnDescriptor | undefined
   nodeName(nodeId: string): string
+  /** Family breakdown of the connections currently in `room` (for broadcast attribution). */
+  roomWires(room: string): { family: TransportFamily; count: number }[]
 }
```
- New `eventWire(event, r): WireAttribution | undefined` returning either a single chip or a breakdown:

| event | attribution | quality |
|---|---|---|
| `connect` | `transportLabel(event.descriptor.transport)` | exact |
| `disconnect`, `msg.request`, `msg.response`, `room.*`, `topic.*` | `r.conn(connId)?.transport` → label | exact (best-effort if conn already purged) |
| `msg.event` (target = connId) | `r.conn(event.target)?.transport` → label | exact |
| `msg.broadcast` (room) | `r.roomWires(event.room)` → `ws×3, http×2` | exact (rooms are in every descriptor) |
| `msg.publish` (topic) | **undefined** | topic subs aren't in `ConnDescriptor` → not attributable; show no chip |
| `msg.serverRequest`, `msg.serverReply` (target = node) | **undefined** | adapter axis (node↔node), not a client wire — intentionally unbadged |

```ts
export type WireAttribution =
  | { kind: 'one'; label: string; color: string }
  | { kind: 'many'; parts: { short: string; count: number; color: string }[] }
```

### 15. `packages/control-center/src/components/live-feed.tsx` — render the chip
- Extend the `resolver` useMemo (lines 85-92) with `roomWires`:
```ts
roomWires: (room) => transportsOf(connections.filter((c) => c.rooms.includes(room))),
```
  (import `transportsOf` from `@/lib/transport`).
- In `FeedRow`, compute `const wire = eventWire(event, resolver)` and render a small chip (a colored dot + label, or
  the `ws×3 http×2` parts) between the summary `<span>` and the chevron.

**Phase-3 gate:** extend `packages/control-center/test/events.test.ts` for `eventWire` (one-conn, broadcast breakdown,
publish→undefined, serverRequest→undefined). Then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Honest caveats (carried into the UI)
- **`msg.publish` is not wire-attributable** — `ConnDescriptor` lists `rooms` but **not** topic subscriptions, so the
  feed shows no wire chip for publishes (best-effort from accumulated `topic.sub/unsub` would be lossy; deferred).
- **`msg.serverRequest`/`msg.serverReply` are deliberately unbadged** — their `target` is a node; these are the
  **adapter** (server↔server) axis, not a client transport. Badging them would conflate the two axes the docs keep
  separate.
- **`transport` is optional everywhere** — conns from a not-yet-upgraded node render as "unknown" rather than breaking
  (graceful for a mixed-version cluster).

## Vocabulary
Header/label word **"Transport"**; values `WebSocket / HTTP · SSE / HTTP · long-poll / libp2p / Loopback`. Reserve
"via" for adapter fan-out; avoid "dial" (libp2p-only).

## File-change summary
**Server/core (Phase 1):** `core/src/transport.ts`, `core/src/adapter.ts`, `server/src/conn.ts`,
`server/src/index.ts` (×3 edits), + `server/test/transport-identity.integration.test.ts` (new).
**CC structural (Phase 2):** `control-center/src/lib/transport.ts` (new), `components/connections-table.tsx`,
`components/conn-detail.tsx`, `lib/topology.ts`, `components/topology-graph.tsx`, `App.tsx`, `components/room-lens.tsx`,
+ `test/transport.test.ts` (new), `test/topology.test.ts` (extend).
**CC feed (Phase 3):** `lib/events.ts`, `components/live-feed.tsx`, + `test/events.test.ts` (extend).

No change needed: `core/src/inspector.ts` (the `connect` event already embeds the descriptor),
`lib/inspector-client.ts` (RPC types re-export from core), `Dockerfile*`/`Caddyfile`.

## Effort
~6 small server edits + 1 test (Phase 1, ~½ hr) · ~7 CC files + 2 test files (Phase 2, ~1–1.5 hr) · 2 CC files + 1
test (Phase 3, ~1 hr). Each phase is independently shippable and gated by `pnpm typecheck && pnpm test && pnpm lint`.
