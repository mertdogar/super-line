# Control Center — Implementation Plan

A shadcn webapp for **debugging and inspecting a running super-line platform**: realtime
topology, contract visualization, connection roles, and per-connection ctx/state.

- **Status:** designed (via `/grill-me`, 2026-06-20), **awaiting review — do not implement yet**.
- **v1 scope:** topology · contract · roles · ctx state · live event feed (read-only).
- **v2 (deferred):** message inspection + history (the v1 `events` channel is its groundwork).

---

## 1. Architecture

### 1.1 How the webapp gets data — WS reserved channel

The introspection data (`srv.cluster.*`, `srv.local.*`) and the contract object live *inside*
each running server process. The Control Center reaches them over **the WebSocket transport
super-line already owns** — not HTTP/SSE, not a Redis reader, not an admin role in the user's
contract.

- A new server option **`inspector: true`** (default `false`) turns it on. Off → zero cost.
- The Control Center connects with the reserved **WS subprotocol `superline.inspector.v1`**.
- The upgrade handler detects that subprotocol → **short-circuits the user's `authenticate`**
  → mints a read-only **inspector connection** with a library-owned ctx. The app's auth logic
  is never touched.
- The inspector connection is **not registered in presence** and is **excluded from every
  result it returns** (the observer never appears in the observed).

**Why not the alternatives** (recorded so we don't relitigate):
- *HTTP/SSE sidecar* — would muscle into the HTTP `request` path the user's framework owns and
  doesn't dogfood the library.
- *Redis presence reader* — blind to single-node in-memory deployments, can't see the contract
  (it's code, not data), can't see ctx, poll-only, and couples to the private `sl:*` key schema.
- *Admin role in the user's contract* — pollutes the domain contract + forces `implement` and
  `authenticate` to grow an admin branch.

### 1.2 Threat model (v1)

`inspector` is **off by default**, documented **dev / trusted-network only**, **no auth**, and
accepts **any `Origin`**. Reserved for later: `inspector: { secret }` and an Origin allowlist.
Rule: never enable `inspector` on an internet-facing production node.

### 1.3 `InspectorContract` — a fixed, library-owned contract

The introspection surface is identical for every super-line app, so it is **not** part of the
user's contract. It is defined as a constant in **`@super-line/core`** (so both the server and
the SPA's baked-in client import its types). Inbound dispatch **branches** on "is this an
inspector conn?" → routes against `InspectorContract`. No merge into the user contract, no
`RoleOf<C>` pollution.

**Requests (inspector → server, req/res):**

| Method | Returns |
|---|---|
| `getContract()` | `{ shared, roles, serverToServer }`; each message → `{ name, flavor, input?, output?, payload? }` where `flavor ∈ {request, event, topic, serverRequest}` and schemas are **best-effort JSON Schema** (omitted on fallback) |
| `getTopology()` | `NodeStat[]` — `{ nodeId, connections, rooms, alive }` |
| `listConnections()` | `ConnDescriptor[]` — cluster-wide, via `srv.cluster.connections()` |
| `getNode()` | the connected node's `{ nodeId, rooms, topics }` (via `srv.local`) |
| `getConn(id)` | `{ descriptor, ctx?, data?, ctxAvailable }` — ctx/data safe-serialized, node-local, on-demand |

**Topic (server → inspector, live push — `subscribe: true`):**

`events` → discriminated union, **fanned out cluster-wide via the existing Adapter** (so an
inspector on any one node sees churn from every node):

```ts
| { type: 'connect';    descriptor: ConnDescriptor }
| { type: 'disconnect'; connId: string; nodeId: string }
| { type: 'room.add';    connId: string; room: string }
| { type: 'room.remove'; connId: string; room: string }
| { type: 'topic.sub';   connId: string; topic: string }
| { type: 'topic.unsub'; connId: string; topic: string }
```

Fully-live by choice: room/topic transitions emit too. Accepted cost = one small publish per
transition; publishing to a channel with no subscribers is cheap in both backends, so v1 does
**not** gate emission on "is anyone watching" (clean future optimization if it ever runs hot).

### 1.4 Contract field shapes — `@standard-community/standard-json`

Contract schemas are opaque Standard-Schema validators (no field names at runtime, no Zod
assumption). Field-level shapes come from **`@standard-community/standard-json`**:

- Single generic `await toJsonSchema(schema)` that dispatches on `schema['~standard'].vendor`
  and **lazy dynamic-imports** the per-vendor converter (`zod-to-json-schema`,
  `@valibot/to-json-schema`, Zod 4 native, …). `quansync` (sync + async forms).
- On unknown/uninstalled vendor it **throws** `UnsupportedVendorError` / `MissingDependencyError`
  → we **catch per-message and fall back to structure-only** for that entry.
- We **lazy-`import()`** the package only inside the inspector path → it's an
  `optionalDependency`, zero cost when `inspector` is off, and the core stays
  validator-agnostic (the package is itself the agnostic façade and does not bundle converters).
- Output is **best-effort / lossy** (`.refine()`/`.transform()`/branded/recursive drop) — the UI
  labels it "schema (best-effort)".

### 1.5 ctx / conn.data — auto safe-serialized, node-local

`getConn(id)` returns ctx and `conn.data` **auto-serialized** through a **safe serializer**
(never raw `JSON.stringify`, which throws on circular refs and mangles BigInt/handles/instances):
circular → `"[Circular]"`, function → `"[Function]"`, class instance → `"[ClassName]"`,
BigInt → string, depth- and size-capped, never throws.

- Computed **on-demand, node-local, never persisted** to the registry or pushed in `events`.
- `describeConn(conn)` projections already in `ConnDescriptor` show cluster-wide for free.
- **`ctxAvailable: false`** for connections on a *different* node than the one the inspector is
  attached to (per-node-local ctx is deferred — `serverToServer` is emit-only, no node→node
  req/res). Single-node dev sees full ctx for every conn.
- Reserved escape hatch: `inspector: { redact: string[] }` (not in v1).

---

## 2. Packaging

- **Server side** lives **in `@super-line/server`** behind the `inspector` option — it needs the
  upgrade/dispatch/lifecycle hooks, so it can't be a standalone package.
- **Webapp** = new **published** package `packages/control-center`, run via
  **`npx @super-line/control-center --url ws://localhost:3000`**:
  - `bin` serves the built SPA on a local port + opens the browser.
  - Target passed as `?url=`, with an in-app input to switch / add endpoints (multi-cluster).
  - Served over **http** so `ws://localhost` works (mixed-content only bites https→ws).
  - SPA `dist` built in CI and shipped in the tarball.
- **Inspector client baked into the SPA** (reuses the existing client wire machinery typed
  against `InspectorContract`). Extract `@super-line/inspector-client` later only if someone
  wants to build custom dashboards.

---

## 3. UI

- **Stack:** Vite + React + **shadcn** + Tailwind + **React Flow (`@xyflow/react` v12)**.
  (Confirm exact versions via Context7 at build time.)
- **IA:** shadcn sidebar dashboard — **Topology** (default) / **Connections** / **Contract** /
  **Live feed**. Clicking a conn opens a **detail drawer** with its ctx/data snapshot.
- **Topology view:** **hub-and-spoke**, the **bus (Redis/Adapter) drawn as a first-class node**.
  Edges that physically exist only: `conn → node` and `node → bus` (there are *no* direct
  server↔server sockets). Connections colored by role. Rooms/topics are a **highlight lens** —
  selecting one lights up its member conns across nodes (not permanent edges).
  **Draw-everything** (≤ ~100 conns target); render up to a **~500 soft cap** with a "showing
  500 of N — targets small clusters" banner instead of locking the browser.
- **Read-only.** `toConn().close()` / `toUser().disconnect()` / `toConn().request()` exist
  server-side but control actions are deferred to a later version alongside auth.

---

## 4. Integration points in the current codebase

(From source survey — verify line numbers at implementation time; structure is stable.)

- `packages/core/src/contract.ts` — `Contract`, `Directional`, `RequestDef`, `ServerMessageDef`,
  `ServerRequestDef`, `RoleBlock`. **New:** `InspectorContract` constant + types; a runtime
  walker that classifies each entry's flavor.
- `packages/core/src/adapter.ts` — `ConnDescriptor`, `NodeStat`, `PresenceStore`. Reused as-is.
- `packages/core/src/wire.ts` — frame types (`req/res/err/evt/pub/sub/unsub/sreq/sres/serr`).
  The inspector reuses `req/res` + topic `sub/pub`; no new wire frames expected.
- `packages/server/src/index.ts` — `createSocketServer(contract, opts)`, `ServerOptions`,
  `SocketServer`, `srv.local` / `srv.cluster` / `srv.nodeId`, upgrade handling, dispatch,
  `onConnection`/`onDisconnect`, `Room`. **Touch points:**
  1. **upgrade** — detect `superline.inspector.v1` subprotocol, short-circuit `authenticate`,
     mint inspector conn (skip presence registration).
  2. **dispatch** — branch inspector conns to `InspectorContract` handlers.
  3. **lifecycle emit** — publish `events` on the reserved channel from connect/disconnect and
     the `Room.add/remove` + topic `joinChannel/unsubscribe` paths.
  4. **ServerOptions** — add `inspector?: boolean | { redact?: string[] }`.
- `packages/server/src/conn.ts` — `Conn` (`id`, `role`, `ctx`, `data`, …). Reused; the safe
  snapshot reads `conn.ctx` + `conn.data`.
- `packages/server/src/memory-adapter.ts` + `packages/adapter-redis/src/index.ts` — presence
  + pub/sub fan-out for the `events` topic. Reused; no schema change.

---

## 5. TDD slice roadmap (one commit per slice)

Each slice: red → green → typecheck + oxlint + tests, integration-first over real loopback
(`server.listen(0)`), cross-node via shared adapter / testcontainers redis.

| # | Slice | Acceptance |
|---|---|---|
| 1 | **core: `InspectorContract` + types** | constant + flavor classifier exported from `@super-line/core`; unit test enumerates a sample contract's roles/directions/flavors |
| 2 | **server: inspector connection** | subprotocol detection + `authenticate` short-circuit + observer-invisible (not in presence/results) + dispatch branch; `getTopology`/`listConnections`/`getNode` return live data; an inspector conn does not appear in its own `listConnections` |
| 3 | **server: `getContract`** | structure always; field JSON Schema via lazy `standard-json` when a converter is present; **structure-only fallback** when absent (test both: zod present → shapes; no converter → names+flavors only) |
| 4 | **server: `getConn` + safe ctx/data** | safe serializer handles circular/BigInt/function/instance without throwing; node-local; `ctxAvailable:false` for a conn on another node |
| 5 | **server: live `events` topic** | connect/disconnect/room/topic events delivered to a subscribed inspector; **cross-node fan-out** verified (event on node B reaches inspector on node A) via testcontainers redis |
| 6 | **control-center: SPA scaffold** | `packages/control-center`, Vite+React+Tailwind+shadcn, sidebar IA, baked inspector client, `?url=` + endpoint switcher; connects and renders raw topology JSON |
| 7 | **control-center: Topology view** | React Flow hub-and-spoke (bus node, conn→node, node→bus), role colors, room/topic highlight lens, draw-everything + soft cap; updates live from `events` |
| 8 | **control-center: Connections / Contract / Feed** | Connections table + ctx/data detail drawer; Contract explorer (structure + best-effort JSON-Schema render, labeled); Live feed of `events` |
| 9 | **control-center: `npx` + docs + publish prep** | `bin` serves built SPA + opens browser; README + docs-site page; publishConfig/exports/build gate (publint/attw) consistent with other packages |

---

## 6. Deferred

Per-node-local ctx for *remote* connections (needs node→node req/res; `serverToServer` is
emit-only) · auth / shared-secret gate · Origin allowlist · control actions (kick/disconnect/
send-test) · connection aggregation + server-side pagination · hosted static SPA · published
`@super-line/inspector-client` · **v2: message inspection + history** (extends the `events`
channel + a persistence layer).

## 7. Risks / honest costs

- **Core surgery** is concentrated in three spots (upgrade detect · dispatch branch · lifecycle
  emit) — the most type-sensitive parts of the library; needs care to keep the reserved namespace
  out of user-facing types.
- **Bus traffic** scales with room/topic churn (fully-live). Acceptable for v1; gate-on-watch is
  the escape valve.
- **JSON Schema is lossy** — communicated in the UI.
- **`draw-everything`** melts above a few hundred conns — the soft cap is the only guard in v1.
