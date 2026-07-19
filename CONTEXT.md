# Context — super-line

A glossary of super-line's domain language — grown from the persisted-state (Store) design, now covering composition/embedding too. Terms only — no implementation details. Updated inline as decisions crystallise during design.

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
Resolved 2026-06-23. The identity a Resource's `accessRules` are keyed by, and the thing the server checks a caller against on read/write. **Reuses the existing `identify(conn)` hook**, with a fallback: `principal = identify(conn) ?? conn.id`. This makes the principal **always defined** (no anonymous-undefined case in the ACL code). Tradeoff: `identify` configured → stable principal → grants survive reconnect; `identify` absent → the random per-connection `conn.id` is the principal → grants live only for the connection's lifetime (stable-anonymous identity is an app concern: client generates an id, passes it via handshake params, `identify` reads it). Verified 2026-06-23: super-line does NOT currently assign any fallback — an `identify`-less conn is fully anonymous (no user channel, no `userId` in presence). This fallback is **new behaviour to add**. Distinct from [[Replica origin]].

### Replica origin
Resolved 2026-06-23. The `origin` on a [[Change]]: a **per-replica/per-connection writer id**, owned by the Store's **client half** (e.g. derived from its wrapped [[super-store]] doc), **opaque to super-line core** — used only for echo-break and attribution. Explicitly **NOT** the [[Principal (the ACL identity)]]: two tabs of the same user share a principal but have distinct origins, so each receives the other's edits (the canonical multiplayer case). Also **NOT** the CRDT-internal actor id (Yjs/Automerge assign that inside super-store for merge math). Three identities, three jobs — principal (*may* this writer write), origin (*whose* update, for echo-break), CRDT actor (merge math).

### Access control (accessRules)
Resolved 2026-06-23. **Server-authoritative, deny-by-default.** A Resource's `accessRules` map a [[Principal (the ACL identity)]] → `{ read, write }`. `create` / `grant` / `revoke` are **server-side methods only** (`srv.store.create/grant/revoke(...)`), invoked by the app's own code — typically inside a normal contract request handler (so privileged ops still route through the typed request spine). **Clients never create Resources or change access**; they may only read/write within already-granted bounds. A principal absent from `accessRules` has neither read nor write. Unknown or unpermitted id → `NOT_FOUND` on read, `FORBIDDEN` on write. `read` gates both catch-up fetch and the live [[Change]] stream; `write` gates submitting updates. (Whole-Resource granularity — no per-field rules.)

### Clustering mode (relay | self)
Resolved 2026-06-23. A capability the **server-half Store declares**, telling super-line core how cross-node sync happens for it. `relay`: the Store is node-local (zero networking); **core relays opaque [[Change]]s across nodes over the existing adapter**, feeding an arriving Change into the node's local Store (symmetric write) + local subscribers, echo-broken by [[Replica origin]] + the existing per-node `instanceId`. Each node holds a replica (the synced-state pattern, formalized). `self`: the Store talks to a **shared backend** (Redis/Postgres) that is canonical truth and handles its own cross-node consistency; core fans Changes only to local subscribers and does not relay over the adapter. The in-memory store is `relay`; a Redis store is `self`; a CRDT store is naturally `relay` (replicas converge via the adapter). Cost: core and the interface carry two code paths.

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

### Surface (contract fragment)
Resolved 2026-07-03. An **exportable fragment of a contract** — one `Directional` (`clientToServer` + `serverToClient` maps) that a super-line-powered library ships for a host app to mount into *its own* contract. Authored via `defineSurface` (which preserves literal keys and `subscribe: true` the way `defineContract` does inline — without it a separately-declared fragment silently degrades topics to events) and combined via `mergeSurfaces`, where a **duplicate key is a compile error naming the key** (plus a runtime throw), never a silent spread-clobber. A Surface carries no roles and no `data` schema — those belong to the host. The unit of [[Composition (embedding)]].

### Composition (embedding)
Resolved 2026-07-03 (ADR-0004). How one super-line-powered library rides inside a host app: **one server, one client, one session, one identity** — the library exports [[Surface (contract fragment)]]s plus its handlers and store configs; the host weaves them into its contract, `implement`, and `stores`, and owns roles, `authenticate`, `identify`, and middleware. **Namespacing is a key-prefix convention, not a wire feature**: the library hard-prefixes its request/event keys, store names, and room names (e.g. `harness.join`) in its own source. Chosen over Socket.IO-style connection namespaces and over a mux transport (two independent sessions on one socket — deferred, `PLAN-transport-mux.md`) because the driving requirement was *shared identity*, which composition gives by construction. Distinct from [[Transport vs Adapter]]: composition happens above the wire entirely.

### Plugin (runtime bundle)
Resolved 2026-07-04. A **named bundle of runtime contributions** registered with the server in one place (`plugins: [...]`) — a [[Tap (node-local observation)]], lifecycle hooks, middleware, request handlers, named stores — every part optional. One concept serves two audiences: an *operator plugin* is tap-only (metrics/audit/tracing); a *library plugin* is the runtime half of [[Composition (embedding)]]. A Plugin is **runtime-only by constraint**: end-to-end types hang off the contract object, so a library's typed surface cannot ride inside a Plugin — it ships a Plugin **paired with** a [[Surface (contract fragment)]] the host still merges explicitly — and the pairing is typed: a Plugin is declared over its Surface, so plugin-covered contract keys are subtracted from the host's `implement` obligation at compile time (forgetting the plugin, or double-implementing its keys, stays a compile error, per the mergeSurfaces discipline). Distinct from the four pluggable seams ([[Transport vs Adapter]], Store, Serializer), which *implement* super-line's interfaces; a Plugin *contributes into* the host app. Dissolves the singular-hook collision (two concerns can now both observe connections/errors without hand-composition). Ships as a **pair, exactly like a Transport or a Store** (resolved 2026-07-04): a server half and an optional client half — the client half bundles the library's client store configs, its server→client request handlers, and connection-lifecycle callbacks (which the client grows for the first time via this design); an operator plugin is typically server-only. The React layer needs no plugin awareness — it rides the client's public surface. **Acceptance test (committed 2026-07-04): the inspector + Control Center must be expressible as a Plugin** — phase 1 makes the inspector the first internal consumer of the Tap; phase 2 adds plugin-owned connections and extracts it fully.

### Tap (node-local observation)
Resolved 2026-07-04. The observation capability of a [[Plugin (runtime bundle)]]: fired **synchronously on the node where the operation happens**, receiving live payload references (observer must not mutate) — no snapshotting, no envelope, zero cost when no plugin taps. Deliberately node-local: cluster-wide views are **built by plugins, not provided by the Tap** — a plugin composes local taps with adapter/bus access to ship events across nodes (the inspector's own pattern). The event vocabulary is the inspector's existing taxonomy (connect/disconnect, room/topic lifecycle, `msg.*`, `store.*`). Distinct from middleware (an inbound *gate* that can reject): a Tap only observes, and may react by initiating new operations — never veto or transform in-flight ones.

### Transport vs Adapter
Two distinct pluggable seams, never conflated. A **Transport** carries client↔server bytes — the wire (WebSocket default; also HTTP-SSE, libp2p, loopback). An **Adapter** carries server↔server, node-to-node fan-out (Redis, libp2p, RabbitMQ, ZeroMQ). A `relay` store (see [[Clustering mode (relay | self)]]) rides the Adapter for cross-node sync; a `self` store owns its own central backend and needs no Adapter.

### Collection runtime
Resolved 2026-07-13. The server-side authority for contract-declared **Collections**, spanning both consistency models: LWW rows and CRDT documents. It is one Collection concept with mode-specific behavior, not a merger of the row and CRDT persistence seams.

### Collection batch
Resolved 2026-07-13. An atomic, ordered set of LWW row mutations across one or more Collections. Each mutation observes the effects of earlier mutations in the same batch; CRDT document mutations never participate.

### Collection policy
Resolved 2026-07-13. A deny-by-default, retry-safe authorization predicate governing client access to a Collection. A Collection policy decides access without producing effects; server-authoritative writes do not pass through it.

### Change source
Resolved 2026-07-13. The attribution attached to an LWW row change: the client Principal, `server`, or `plugin:<name>`. Distinct from a CRDT [[Replica origin]], which identifies one replica for echo-breaking.

### Cluster (node identity over the Adapter)
Resolved 2026-07-15. A thin module over the [[Transport vs Adapter]] Adapter owning the one fact every cross-node frame carries: **which node published it**. It stamps that id outbound, encodes/decodes through the Serializer, and reports `own` inbound — so no call site hand-rolls `frame.nd === instanceId`. Before it, one concept had three mechanisms and two spellings (`nd` on collection/CRDT frames, `i` on bus/plugin-channel frames, plus the CRDT `relaying` flag) across nine sites.

It owns **detection, never policy**, because there are two correct [[Local delivery strategy]] choices and which one a caller made decides what `own` means to it. It also hands back the **raw bytes** beside the decoded frame, because CRDT fan-out relays them straight through (`conn.sendRaw`) — one pre-encoded buffer to N connections. That is why the id is stamped **into** the frame rather than wrapped in an envelope: an adapter payload must stay a valid client frame (`nd` is declared on client-visible frame types, documented as ignored by clients). The field is **node-local** — each node recognises only its own stamp — so a mixed-version cluster stays correct.

Distinct from the Adapter (carries the bytes; guarantees the loopback) and from [[Replica origin]] (a per-*writer* id that survives relay, and so cannot stand in for node identity).

### Local delivery strategy
Resolved 2026-07-15. How a node gets a cross-node message to its *own* subscribers. super-line has two, both correct, and the choice decides the echo-break policy — which is why [[Cluster (node identity over the Adapter)]] reports `own` rather than acting on it:

- **deliver-at-source** — fan out to local listeners at publish time, then *drop* the looped-back copy. Used by the cluster bus, plugin channels, and row [[Collection runtime]] relay. Rows have no choice: `store.onChange` fires on the writing node at apply time, and a `self` backend never publishes at all.
- **deliver-on-receipt** — do *not* deliver locally on publish; let the Adapter's guaranteed loopback come back and fan out on arrival. This is the Adapter's own documented design ("a node delivers to its local members on receipt — one code path, no double-send"), used by rooms/topics and by CRDT document relay, which forwards the frame **regardless** of `own` and uses `own` only to skip re-applying its own delta.

A Cluster that quietly filtered own-messages would break every CRDT client's local delivery. The asymmetry is pinned by `packages/server/test/collections-cross-node.integration.test.ts`.

### Relay-sync invariant
Resolved 2026-07-15. A **`relay` backend's `apply` must be synchronous** — for both [[Collection runtime]] families. The relay ingress path fires-and-forgets (`void apply(...)`) so a cross-node race lands in a `try`/`catch`, and the CRDT side guards re-publish with a flag cleared in `finally`; an async `apply` escapes that catch and clears that guard before the change is emitted, turning one relayed write into a cluster-wide echo storm. [[Replica origin]] cannot substitute for the flag: it identifies the *writer* and survives the relay, so a receiving node cannot distinguish a relayed delta from a local write by that same writer. A `self` backend is exempt — it never relays. The rule was real and load-bearing but recorded only in `collections-crdt-libsql`'s private doc comment (that backend keeps its hot path sync and persists off `onChange` for exactly this reason); it now lives on `CollectionStore.apply` / `CrdtCollectionStore.apply`. Expressing it in the type system — splitting each seam into a discriminated union on `clustering`, which already discriminates — is the real fix and is still open (breaking; core + 6 backends; wants an ADR).

### Credential
Resolved 2026-07-17. The **durable stored secret** that proves a connection's identity: a **password hash**
(`credentials` collection) for a human, an **API key** for a bot. Verified at login/connect. Distinct from a
[[Session token]] (which is issued *after* a credential is verified) and from [[Connection ctx (identity)]]
(the resolved identity, not the secret).

### Session token
Resolved 2026-07-17. A **re-sendable substitute for a password**, issued once a [[Credential]] is verified, so
a human's browser can reconnect without re-sending the password — and so a login can be revoked without
changing the password. **Humans only.** A bot needs none: its **API key is already a safely-re-sendable durable
credential**, so `sessionId: null` on an API-key connection is correct, not a gap.

### Connection session
Resolved 2026-07-17. A **live connection plus its server-side state**. Every authenticated connection has one —
bots included. Its server-only identity is [[Connection ctx (identity)]]; its client-visible slice is
[[Connection env]].

### Connection ctx (identity)
Resolved 2026-07-17. The **frozen, server-only identity** a connection authenticated as (`{ userId, roles,
sessionId }` under plugin-auth) — the value `authenticate` returns as `ctx`, stashed `readonly` on `conn.ctx`
and used as the **trusted input to authorization** (handlers, row policies). Server-only and frozen for two
reasons: authz must key on an unchanging, unforgeable identity, and hosts stash *server-only* per-connection
state here. The opposite corner of the visibility×mutability grid from [[Connection env]] — the two are
**paired at the source** (`authenticate → { role, ctx, env }`) but never merged.

### Connection env
Resolved 2026-07-17 (ADR-0012). A **typed, per-connection, server-vended, client-visible, mutable, ephemeral**
state bag — the visibility-mirror sibling of `conn.data` (*"`data` is server-side scratch; `env` is the same,
but the client sees it"*). Declared per role on the contract (`roles.R.env`), seeded by `authenticate`
alongside [[Connection ctx (identity)]], updated live via `conn.setEnv` / `srv.toUser(id).setEnv`, read on the
client as `client.env` (`current`/`ready`/`subscribe`) / React `useEnv()`. super-line is a **pure courier**: it
validates and delivers the payload but never interprets, acts on, or attributes it (no impersonation, no
on-behalf-of). **Never persisted** — it holds live external credentials and lives only in memory, re-seeded on
reconnect. Its intended use is an agent's *runtime* wiring the creds into its tool implementations (the LLM
never sees it). Surfaced in the Control Center (`ConnView` + an `env.set` feed event) **masked by default** —
values hidden unless a key is host-allow-listed (`revealEnvKeys`) — because `env` always holds creds. Distinct
from [[Store]] (persisted, ACL'd) and from a [[Collection policy]] (authorization, not delivery).

### Settle (streamed message)
Resolved 2026-07-19 (ADR-0014). The transition of a streamed message from `streaming` to a **terminal status** (`complete` · `aborted` · `error`), exactly once. Carries the invariant **a streamed message always settles before it vanishes**: deleting a still-streaming message (or its channel) settles it first, so a consumer may treat any non-`streaming` status as a reliable turn boundary, and the settle signal always releases the producer's stream handle — whoever deleted, from whichever node. Cancellation, deletion, disconnect, kill-switch, caps, and shutdown drain are all expressions of the same settle; the producer never finalizes after one lands (a settle is server-authoritative and happens once).

### Framing chunk
Resolved 2026-07-19. An adapter-recognized stream chunk carrying **no transcript content** — run/step boundaries and message metadata. Known framing is dropped from the durable transcript, but the host's `mapDataPart` gets **first refusal** before the drop, because host-relevant payloads (token usage above all) ride framing; unmapped framing drops silently and is never reported "unsupported". Distinct from dropped *content* chunks (streaming tool args), which stay adapter-owned and are never offered.

## Resolved (Store design, 2026-06-23)
The Store-grilling session resolved the load-bearing architecture; each is a glossary term above. In short: [[Store]] is the foundational primitive (CRDT is one impl); [[Change]] is an opaque `{id,update,origin}` relayed symmetrically; a Store is a [[Store pair (server half / client half)]]; [[Principal (the ACL identity)]] = `identify ?? conn.id`; [[Replica origin]] is a distinct per-writer id; the [[Store surface (off-contract, generic)]] is untyped (ADR-0003); [[Access control (accessRules)]] is server-authoritative, deny-by-default; [[Clustering mode (relay | self)]] is Store-declared; [[Named store]]s are independently-configured pairs; the client uses a [[Resource handle]]; [[Store inspector events]] give Control Center visibility; [[Packaging]] keeps Yjs in super-store. CRDT binding = Yjs via [[super-store]] (ADR-0002, supersedes ADR-0001).

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
