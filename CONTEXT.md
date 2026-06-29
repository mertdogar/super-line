# Context — super-line persisted-state (Store) + synced-state / CRDT

A glossary of the domain language for super-line's persisted-state feature. Terms only — no implementation details. Updated inline as decisions crystallise during design.

## Glossary

### Store
Resolved 2026-06-23. The **foundational persisted-state primitive** of super-line, and a pluggable seam (like a Transport or an Adapter): an interface anyone can implement, with an in-memory implementation shipped first. A Store persists **Resources** and defines a single **consistency model** (how a write mutates a Resource's `data`). The CRDT **Shared Document** is *one* Store implementation (`data` = opaque CRDT bytes, merged) — not a separate feature. *"One plumbing, two consistency models":* a last-writer-wins `MemoryStore` and a merging `CrdtStore` are siblings behind the same interface. Distinct from a **Topic** (fire-and-forget broadcast, no state) and from per-connection **data** (scratch state lost on disconnect). (NB: "store" was previously used informally to mean the persistence `Map` in the synced-canvas examples, and `PresenceStore` in core — this promotes it to a first-class term; those usages must be disambiguated.)

### Resource
The unit a Store persists: `{ id: string, accessRules, data: JSON }`. `id` is a unique record id. `accessRules` gate which participants may read/write. `data` is the JSON payload (for a `CrdtStore`, opaque merge bytes). (Shape and identity of the accessRules key — see Open question on identity — still to resolve.)

### Change
Resolved 2026-06-23. What a Store emits when a Resource mutates, and the symmetric shape a write carries IN: `{ id, update, origin }`. `update` is a **store-defined opaque payload** — a CRDT delta for a `CrdtStore`, the full JSON value for a last-writer-wins store. super-line **never parses `update`** (relays it like transport/adapter bytes; base64 under the JSON serializer). `origin` is the writer id used for **echo-break** (don't bounce a writer's own change back into its replica). Mirrors the opaque-relay pattern already in `docs/guide/synced-state.md`. NB: super-store's in-process callback is payload-less (`subscribe(() => void)` + re-read); the networked Store needs the payload + origin that callback lacks.

### Store pair (server half / client half)
Resolved 2026-06-23. A Store implementation ships as a **pair, exactly like a Transport** (`webSocketServerTransport` / `webSocketClientTransport`): a **server half** (persists Resources; emits/accepts opaque `{id, update, origin}` [[Change]]s) and a **client half** (a local replica that applies opaque updates and exposes a reactive read; a `CrdtStore`'s client half wraps [[super-store]]'s `StoreValue` to merge). **super-line core owns the relay** — ACL enforcement, fan-out (reusing the existing adapter + rooms), and the generic store methods it adds to each instance — and **never touches `update`**. The Store owns persistence + the consistency model. Merge logic lives in the client half, never in core (core is CRDT-agnostic).

### Store surface (off-contract, generic)
Resolved 2026-06-23. The read/write/subscribe methods are added to the client/server **instances** when a Store pair is configured — **NOT declared in `defineContract`**, and deliberately **outside** super-line's "one contract / end-to-end types / validate every inbound message" spine. Shape: a generic KV-style API addressed by `name.id`, where `data` is caller-asserted (`unknown` on the wire); **core does not schema-validate store `data`** (there is no contract schema for it). Conscious tradeoff: maximum flexibility / a generic store client, at the cost of the typed-contract guarantees the rest of super-line provides.

### Named store
Resolved 2026-06-23. Server and client each configure a **map of named Store pairs** (`stores: { scene: crdtStoreServer(), config: memoryStoreServer() }`); `name` **selects one independently-configured backend** (not a key prefix), so each named store has its own consistency model, [[Clustering mode (relay | self)]], and persistence — one app can run a CRDT `scene` store and an LWW `config` store side by side. Surface: `client.store.<name>.read(id) / write(id, data) / subscribe(id, …)`; server-side `srv.store.<name>.create/grant/revoke(...)`. The **server mints Resource ids** (clients can't create). Per-name operations: read / write / subscribe / delete by id, and list (scoped to the name, [[Access control (accessRules)]]-filtered).

### Principal (the ACL identity)
Resolved 2026-06-23. The identity a Resource's `accessRules` are keyed by, and the thing the server checks a caller against on read/write. **Reuses the existing `identify(conn)` hook**, with a fallback: `principal = identify(conn) ?? conn.id`. This makes the principal **always defined** (no anonymous-undefined case in the ACL code). Tradeoff: `identify` configured → stable principal → grants survive reconnect; `identify` absent → the random per-connection `conn.id` is the principal → grants live only for the connection's lifetime (stable-anonymous identity is an app concern: client generates an id, passes it via handshake params, `identify` reads it). Verified 2026-06-23: super-line does NOT currently assign any fallback — an `identify`-less conn is fully anonymous (no user channel, no `userId` in presence). This fallback is **new behaviour to add**. Distinct from [[Origin (writer id)]].

### Origin (writer id)
Resolved 2026-06-23. The `origin` on a [[Change]]: a **per-replica/per-connection writer id**, owned by the Store's **client half** (e.g. derived from its wrapped [[super-store]] doc), **opaque to super-line core** — used only for echo-break and attribution. Explicitly **NOT** the [[Principal (the ACL identity)]]: two tabs of the same user share a principal but have distinct origins, so each receives the other's edits (the canonical multiplayer case). Also **NOT** the CRDT-internal actor id (Yjs/Automerge assign that inside super-store for merge math). Three identities, three jobs — principal (*may* this writer write), origin (*whose* update, for echo-break), CRDT actor (merge math).

### Access control (accessRules)
Resolved 2026-06-23. **Server-authoritative, deny-by-default.** A Resource's `accessRules` map a [[Principal (the ACL identity)]] → `{ read, write }`. `create` / `grant` / `revoke` are **server-side methods only** (`srv.store.create/grant/revoke(...)`), invoked by the app's own code — typically inside a normal contract request handler (so privileged ops still route through the typed request spine). **Clients never create Resources or change access**; they may only read/write within already-granted bounds. A principal absent from `accessRules` has neither read nor write. Unknown or unpermitted id → `NOT_FOUND` on read, `FORBIDDEN` on write. `read` gates both catch-up fetch and the live [[Change]] stream; `write` gates submitting updates. (Whole-Resource granularity — no per-field rules.)

### Clustering mode (relay | self)
Resolved 2026-06-23. A capability the **server-half Store declares**, telling super-line core how cross-node sync happens for it. `relay`: the Store is node-local (zero networking); **core relays opaque [[Change]]s across nodes over the existing adapter**, feeding an arriving Change into the node's local Store (symmetric write) + local subscribers, echo-broken by [[Origin (writer id)]] + the existing per-node `instanceId`. Each node holds a replica (the synced-state pattern, formalized). `self`: the Store talks to a **shared backend** (Redis/Postgres) that is canonical truth and handles its own cross-node consistency; core fans Changes only to local subscribers and does not relay over the adapter. The in-memory store is `relay`; a Redis store is `self`; a CRDT store is naturally `relay` (replicas converge via the adapter). Cost: core and the interface carry two code paths.

### Resource handle
Resolved 2026-06-23. The client-side object returned by `client.store.<name>.open(id)`: a **reactive handle mirroring [[super-store]]'s `StoreValue` surface** — `getSnapshot()`, `subscribe(cb)`, `set(data)` / `update(partial)`. Catch-up is async (snapshot starts empty/loading, fills from the server), live [[Change]]s update it, and **reconnect re-snapshots automatically** (at-most-once delivery, per the existing synced-state guidance — re-fetch on reconnect; idempotent for CRDT). Writes go through the handle: LWW wraps a plain value so `set()` emits a full-value Change; a `CrdtStore` handle wraps a real `StoreValue` so `set`/`update` mutate the local doc and emit a **delta** Change. One surface unifies both consistency models. One-shot `read(id)` / `write(id, data)` are thin sugar over the handle. The React hook `useResource(name, id)` is a trivial `useSyncExternalStore` wrapper over it.

### Store inspector events
Resolved 2026-06-23. Store operations are **first-class in the Control Center**, mirroring the existing always-on `msg.*` telemetry. New `store.*` inspector events (`store.write`, `store.change` (fan-out), `store.grant`, `store.revoke`, `store.subscribe`/`unsubscribe`) are emitted from the server send-sites, cluster-wide over the bus, always-on when `inspector: true`, payloads safe-snapshotted + `inspector.redact`-masked — exactly like `msg.*`. The Control Center gains a **Store** live-feed filter and can surface a Resource's `accessRules`. Keeps a first-class primitive from reading as second-class in the debugger.

### Packaging
Resolved 2026-06-23. The **Store interface types** (`ServerStore` / `ClientStore` / `Resource` / `Change` / `AccessRules` / clustering mode) live in **`@super-line/core`** (beside `RawConn` / `ServerTransport` / `ClientTransport` / `Adapter`). The default LWW **in-memory store** ships as **`@super-line/store-memory`** (`memoryStoreServer()` / `memoryStoreClient()`). **`useResource`** lives in **`@super-line/react`**. **As built (deviation):** the **CRDT pair ships in *this* repo as `@super-line/store-sync`** (`syncStoreServer()` / `syncStoreClient()`), depending on the npm-published `@super-store/store` engine + the workspace `@super-line/core` — decided once super-store was published, so the binding builds with no cross-repo release coupling. Yjs is still confined to that one optional package (never in core/server/client). Also as built: `srv.store(name)` / `client.store(name)` are **methods** (not `Record` properties) to avoid `noUncheckedIndexedAccess` undefined at call sites.

### super-store (the CRDT engine, two layers down)
A separate WIP library at `/Users/mertdogar/Workspace/personal/super-store` (`@super-store/store`): a single Yjs-backed reactive primitive `StoreValue<T>` (one value, `set`/`update`, payload-less `subscribe`+`getSnapshot`, opt-in undo, Yjs convergence). **Not** a super-line Store — no `id`/`accessRules`/collection/list/ACL/cross-node. It is the **engine a future `CrdtStore` implementation of super-line's Store interface will wrap** to hold one Resource's `data`. Layering: super-line `Store` → `CrdtStore` impl → `super-store StoreValue`.

### Shared Document
A named, server-persisted, JSON-projectable state object that the server and one or more clients all read and write **concurrently**, merged via a CRDT. **Now framed as a CRDT Store implementation** (the merging consistency model), not a standalone primitive. The unit of synchronisation. Distinct from a **Topic** (fire-and-forget broadcast, no state) and from per-connection **data** (scratch state lost on disconnect).

### Co-writer
A participant — the server *or* a client — permitted to mutate a Shared Document. In this design **both the server and clients are co-writers with equal write reach**: there is no partition, either party may mutate any field. (Resolved 2026-06-23: user confirmed both parties mutate anywhere in the state, no server-owned vs client-owned regions.)

### Reactive authority (the chosen meaning of "server-authoritative" for a Shared Document)
Resolved 2026-06-23. The server, as the hub all clients sync through, observes the *merged* state and may emit a *compensating* mutation to correct invalid/unauthorised state, always getting the last word. Eventually-consistent: there is a brief window where a "bad" value is visible before correction. Chosen over **Preventive** authority (per-mutation veto), which a CRDT cannot provide — an update is an atomic op-set that cannot be partially rejected. Acceptable here because the state is a design canvas, not money/permissions ("we can tolerate minor issues").

### Scene
The concrete first Shared Document: an OMMA **`Scene`** (`@omma/schema/scene`) — a design canvas (viewport + design elements + media + datasources), persisted today as a `_snapshot.json` content-version blob (GCS/Omma REST), keyed by `sceneUUID`. The unit of co-editing.

### AI agent (the "server" co-writer)
In this project the server-side Co-writers are the **AI agents** (Mastra `chatWorkflow` runs) that edit the Scene as they work. The client Co-writers are the **humans** editing the same Scene on the canvas. Topology (resolved 2026-06-23): **N humans + N AI agents** co-edit one Scene (true multiplayer). Each writer — human connection or agent run — is a distinct CRDT peer with its own actor/client id; ids are never shared (sharing corrupts merge). The agent's edit API is **already granular** (`create`/`updateElement`/`deleteElements`/`reorderElements`, wrapped in `scene.transaction()`), which maps 1:1 onto CRDT mutations.

### Element
A node in a Scene with a **stable string `id`** (e.g. `T_abc123`). Elements live in a **positional array** (`SceneSource.elements[]`); Containers hold child Elements in their own array (`container.value.data.children[]`). Identity is the `id`; *position* in the array is separate state (see Z-order).

### Z-order
The front-to-back stacking of Elements, encoded today as **array index** (last = front-most). This makes z-order a *positional/move* concern, which is the single CRDT operation that needs deliberate modeling — concurrent reordering is the classic CRDT weakness. (Open: model as list-with-move vs keyed-map + fractional-index order field.)

### Reactive validation (compensating change)
The mechanism by which a server Co-writer enforces a rule on a Shared Document: observe the merged state, and if it violates an invariant, emit a *new* (compensating) change that corrects it. The expression of [[Reactive authority]] in practice. The agent's edits and these compensations are the same kind of operation — both are just changes by the server peer.

### Order key (fractional index)
A per-Element string that encodes [[Z-order]] independently of array position, sorted lexicographically at read time. A reorder is a single last-writer-wins write to one Element's order key, so concurrent moves can't duplicate/lose an element. Replaces "z-order = array index" because no CRDT has a safe native list-move.

### ResourceHandle
As-built 2026-06-29. The shipped name of the client-side [[Resource handle]], reached as `client.store(name).open(id)` (a method, not a property). Reactive surface — `getSnapshot` / `subscribe` / `set` / `update` / `delete` — plus a `deleted` boolean signal (see [[Deletion fan-out]]). The React mirror is `useResource(name, id)`, returning `{ data, deleted, set, update, delete }`.

### ServerReplica
As-built 2026-06-29. The **server-side** reactive replica over one Resource's canonical state — the server-half mirror of the client [[Resource handle]]. Reached as `srv.store(name).open(id)`; the server co-writer's seat at a Store. Surface: `getSnapshot` / `subscribe` / `set` / `update` / `delete`. Simpler than the client side because the server mutates canonical state directly (no wire send-up, no second copy to reconcile).

### Deletion fan-out
As-built 2026-06-29. The propagation of a Resource removal across the cluster. `srv.store(name).delete(id)` removes the Resource and fans the removal out as an `sdel` wire frame — to every subscribed client, and between `relay` nodes over the adapter (see [[Transport vs Adapter]]); a `self` store surfaces its backend deletes via `ServerStore.onDelete`. Consumers observe it as the [[ResourceHandle]] `deleted` boolean (React `useResource().deleted`). The delete-side mirror of a [[Change]].

### Transport vs Adapter
Two distinct pluggable seams, never conflated. A **Transport** carries client↔server bytes — the wire (WebSocket default; also HTTP-SSE, libp2p, loopback). An **Adapter** carries server↔server, node-to-node fan-out (Redis, libp2p, RabbitMQ, ZeroMQ). A `relay` store (see [[Clustering mode (relay | self)]]) rides the Adapter for cross-node sync; a `self` store owns its own central backend and needs no Adapter.

## Resolved (Store design, 2026-06-23)
The Store-grilling session resolved the load-bearing architecture; each is a glossary term above. In short: [[Store]] is the foundational primitive (CRDT is one impl); [[Change]] is an opaque `{id,update,origin}` relayed symmetrically; a Store is a [[Store pair (server half / client half)]]; [[Principal (the ACL identity)]] = `identify ?? conn.id`; [[Origin (writer id)]] is a distinct per-writer id; the [[Store surface (off-contract, generic)]] is untyped (ADR-0003); [[Access control (accessRules)]] is server-authoritative, deny-by-default; [[Clustering mode (relay | self)]] is Store-declared; [[Named store]]s are independently-configured pairs; the client uses a [[Resource handle]]; [[Store inspector events]] give Control Center visibility; [[Packaging]] keeps Yjs in super-store. CRDT binding = Yjs via [[super-store]] (ADR-0002, supersedes ADR-0001).

## Open questions (in dependency order)
1. ~~**CRDT choice**~~ → **RESOLVED: Yjs via [[super-store]]** (ADR-0002, supersedes ADR-0001's Automerge choice).
2. ~~**Persistence medium abstraction**~~ / ~~**Surface in super-line**~~ → **RESOLVED**: the pluggable [[Store]] primitive (off-contract generic API, server+client pair); first impl `@super-line/store-memory`.
3. ~~**Z-order modeling**~~ → **RESOLVED on paper**: keyed map `{id → Element}` + per-Element [[Order key (fractional index)]]. Library-agnostic.
4. **Minor lifecycle details (defaulted, not yet ratified)**: `delete(id)` is server-only by symmetry with `create` (a tombstone [[Change]]); `list` returns the ids a principal can read (ACL-filtered), client-callable; `accessRules` perms normalized from the spec's `[write, read]` tuple to `{ read, write }`; LWW write = whole-`data` replace at Resource granularity; reconnect = re-snapshot (at-most-once).
5. **Agent residency**: do AI agents run in-process with the canonical doc (mutate directly) or as separate worker/node peers (sync over the adapter)? *Open.*
6. **Persistence reconciliation**: a `relay`-mode in-memory store's replicas are per-node/ephemeral; durable multi-node needs a `self`-mode (shared-backend) store or per-node CRDT persistence — how the live CRDT doc reconciles with any whole-JSON snapshot/content-version store. *Open.*
7. **Awareness/presence**: cursors/selection/who's-editing — CRDT awareness vs super-line's existing presence directory. *Open.*
8. **Multiplayer undo**: super-store ships opt-in per-actor undo (tracks only `STORE_ORIGIN` writes) — does the `CrdtStore`/super-line surface expose it, and how does it interact with the [[Resource handle]]? *Open.*
9. **Playground scope**: what the first Store example demonstrates (likely a permissioned doc + the CRDT collab canvas re-expressed on the Store). *Open.*
