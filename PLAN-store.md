# PLAN — Store: a pluggable, server-authoritative persisted-state primitive

Make **persisted state** a first-class super-line capability. Today, durable shared state is only a
*pattern* — the `synced-canvas` examples wire a CRDT over events + rooms by hand (`docs/guide/synced-state.md`).
This introduces a **Store** seam: a pluggable backend (in-memory first, CRDT later) holding **Resources**
(`{ id, accessRules, data }`) with per-principal read/write rules, surfaced as read/write/subscribe
methods auto-added to the client and server instances — under the *same* server-authoritative model,
adapter fan-out, and Control Center as everything else.

> Status: **DESIGN — settled in a grilling session (2026-06-23).** Domain language is in `CONTEXT.md`;
> the load-bearing trade-offs are ADR-0002 (Yjs via super-store) and ADR-0003 (stores are off-contract).
> Build is **additive** — no breaking changes — and incremental (LWW pair first, CRDT binding last).

---

## 1. Goal & framing

- One pluggable **Store** seam, mirroring the *philosophy* of the transport seam: a small interface, an
  in-memory default, **one package per implementation**, shipped as a **server half + client half pair**
  (exactly like `webSocketServerTransport` / `webSocketClientTransport`).
- **Store is the foundational primitive; CRDT is one implementation.** *"One plumbing, two consistency
  models"*: a last-writer-wins `memoryStore` and a merging `crdtStore` are siblings behind the same
  interface. The CRDT **Shared Document** of the existing synced-state docs is reframed as a CRDT Store.
- **Server-authoritative, deny-by-default.** The server owns Resources: it creates them, grants/revokes
  access, and gates every read/write against a Resource's `accessRules`. Clients only read/write within
  granted bounds; they never create Resources or change access.
- **Core never parses a Resource's payload.** A [Change](#4-the-seam--interfaces-live-in-super-linecore)
  carries an **opaque `update`** (a CRDT delta, or a full JSON value for LWW). Core relays it like
  transport/adapter bytes — the merge logic lives in the Store's **client half**, never in core
  (core stays CRDT-agnostic).

## 2. Settled trade-offs (so we don't relitigate)

### 2a. Why the Store is NOT in `defineContract` (ADR-0003)
super-line's identity is "one contract, end-to-end types, validate every inbound message." The Store
**breaks that on purpose** for `data`. Two reasons: (1) a Store is a *runtime capability* chosen at
construct time (memory / redis / crdt), like a transport — not a fixed per-message schema; (2) a
`crdtStore`'s `update` is a **binary merge delta** that cannot be schema-validated *in principle* — it
isn't the value, it's an instruction to mutate it. So store `data` is caller-asserted (`unknown` on the
wire) and core does not validate it. Hard gates (money, permissions) still route through normal typed
**requests**, same guidance the synced-state docs already give. The typed-contract spine is untouched for
requests/events/topics.

### 2b. Why not just use topics + rooms (the existing synced-state pattern)?
The pattern works but leaves every app to hand-roll persistence, per-document ACLs, catch-up-on-join,
echo-break, and reconnect re-snapshot. The Store **formalizes that pattern** into a primitive with a
pluggable backend and per-Resource access control — and **reuses** the topic/room fan-out machinery
underneath (a Resource maps to a channel; subscribers join it; a Change publishes to it).

### 2c. Why a server **+ client** pair (not server-only)?
Because the `crdtStore` client must merge opaque `update`s locally (wrapping super-store), and core is
CRDT-agnostic — that merge code can't live in core. So the implementation ships both halves, like a
transport. The server half persists + emits/accepts Changes; the client half is a local replica.

### 2d. Three identities, three jobs
| Identity | Source | Job |
|---|---|---|
| **Principal** | `identify(conn) ?? conn.id` | *May* this writer read/write? (ACL key) |
| **Origin** | per-writer id, owned by the client half | *Whose* Change is this? (echo-break / attribution) |
| **CRDT actor** | Yjs `clientID` inside super-store | merge math (invisible to super-line) |

Conflating Principal and Origin breaks same-user multi-tab co-editing — keep them distinct.

## 3. CRDT engine grounding (grounds §4 / the crdt slice)

The CRDT Store wraps **`super-store`** (`@super-store/store`, a separate repo) — a Yjs-backed reactive
primitive `StoreValue<T>` (plain-object API over Yjs shared types; `set`/`update`; payload-less
`subscribe`+`getSnapshot`; opt-in per-actor undo; Yjs convergence). Layering: super-line `Store` →
`crdtStore` impl → `super-store StoreValue`. Yjs (not Automerge) per **ADR-0002** — super-store already
exists and gives the plain-object ergonomics that originally favored Automerge, without the WASM cost.
**super-store ships the binding** (`@super-store/super-line`), so Yjs stays out of the super-line repo.

## 4. The seam — interfaces (live in `@super-line/core`)

New file `packages/core/src/store.ts`, exported from `core`. Every store package depends on `core`;
`client`/`server` depend only on `core`, never on a specific store.

```ts
type Principal   = string
type Perms       = { read: boolean; write: boolean }
type AccessRules = Record<Principal, Perms>

interface Resource<T = unknown> { id: string; accessRules: AccessRules; data: T }

// Opaque + symmetric: the same shape an onChange emits is what a write carries IN.
interface StoreChange { id: string; update: unknown; origin: string }   // base64 if `update` is bytes

// ---- server half: persistence + consistency model + change-notify. NO acl, NO wire. ----
interface ServerStore {
  readonly clustering: 'relay' | 'self'                  // §5 Q8 — how cross-node sync happens
  read(id: string): Awaitable<Resource | undefined>      // catch-up snapshot (+ accessRules)
  create(id: string, data: unknown, accessRules: AccessRules): Awaitable<void>
  apply(change: StoreChange): Awaitable<void>            // store decides: LWW replace | CRDT merge
  setAccess(id: string, accessRules: AccessRules): Awaitable<void>
  delete(id: string): Awaitable<void>
  list(): Awaitable<string[]>
  onChange(cb: (change: StoreChange) => void): () => void // fires on EVERY applied mutation — the fan-out source
  close?(): Awaitable<void>
}

// ---- client half: a reactive local replica + Change production. ----
interface ClientStore {
  readonly origin: string                                 // this client's per-writer id
  open(id: string): ResourceReplica
  close?(): void
}
interface ResourceReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void                   // useSyncExternalStore-shaped
  set(data: unknown): StoreChange | null                  // local write → Change to send up (null = no-op)
  update(partial: unknown): StoreChange | null
  applyRemote(change: StoreChange): void                  // merge inbound; own-origin = idempotent/no-op
  seed(snapshot: unknown): void                           // catch-up hydrate
}
```

**Reserved off-contract wire frames** (added to `packages/core/src/wire.ts`, mirroring `sub`/`pub`/`req`):
`{t:'sopen',i,n,id}` (subscribe+catch-up → `res` snapshot / `err`), `{t:'sclose',n,id}`,
`{t:'swr',i,n,id,u,o}` (write → `res` ok / `err FORBIDDEN`), `{t:'srd',i,n,id}` (one-shot read),
`{t:'sch',n,id,u,o}` (server→client Change push). `n` = store name, `id` = Resource id, `u` = `update`,
`o` = `origin`.

**Fan-out is one path:** core calls `serverStore.apply(change)` → the store fires `onChange(change')` →
core publishes `change'` to the Resource channel `s:<name>:<id>` (skipping the origin connection) and, for
`clustering:'relay'`, over the adapter. This reuses the existing topic/room channel machinery verbatim.

## 5. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | what a Store is | The **foundational persisted-state primitive**; CRDT is *one impl*. Pluggable like a transport. |
| Q2 | Change shape | **Opaque `{id, update, origin}`, symmetric** — same shape flows in via write. Core never parses `update`. |
| Q3 | topology | **Server + client pair**, like a transport. Server half persists + change-notifies; client half is a local replica (CRDT half wraps super-store). |
| Q4 | identity / principal | **`identify(conn) ?? conn.id`** — always defined. `identify` set → grants survive reconnect; absent → per-connection random principal. (New fallback to add.) |
| Q5 | origin | **Distinct per-writer id**, client-half-owned, opaque to core — NOT the principal, NOT the CRDT actor. |
| Q6 | surface / typing | **Off-contract, generic, untyped `data`** (ADR-0003). `client.store.<name>.read/write/subscribe/open`; core does not schema-validate store data. |
| Q7 | access control | **Server-authoritative, deny-by-default.** create/grant/revoke server-only; clients read/write within granted bounds. Unknown id → `NOT_FOUND` (read) / `FORBIDDEN` (write). Whole-Resource granularity. |
| Q8 | cross-node | **Store declares `clustering: 'relay' \| 'self'`.** `relay` → core relays Changes over the existing adapter (node-local replicas). `self` → store owns a shared backend; core fans only to local subscribers. |
| Q9 | namespacing | **Map of named Store pairs** (`stores: { scene: crdtStore…(), config: memoryStore…() }`); `name` selects an independently-configured backend. **Server mints Resource ids.** |
| Q10 | client API | **Reactive `super-store`-shaped handle** via `open(id)`: `getSnapshot`/`subscribe`/`set`/`update`; async catch-up; auto re-snapshot on reconnect. `read`/`write` are sugar. `useResource` = `useSyncExternalStore` wrapper. |
| Q11 | CRDT binding | **Yjs via super-store** (ADR-0002). Binding ships from the super-store repo (`@super-store/super-line`); Yjs stays out of super-line. |
| Q12 | observability | **First-class `store.*` inspector events**, always-on when `inspector:true`, safe-snapshotted + redact-masked; Control Center gains a **Store** filter. |

## 6. Package taxonomy

| Package | Covers | Notes |
|---|---|---|
| `@super-line/core` | the interfaces + reserved store frames | `ServerStore`/`ClientStore`/`Resource`/`StoreChange`/`AccessRules` in `src/store.ts` |
| `@super-line/store-memory` | default **LWW** pair | `memoryStoreServer()` / `memoryStoreClient()`; `clustering:'relay'`; the test/dev default |
| `@super-line/react` | `useResource(name, id)` | mirrors `useSubscription`'s `useState`+`useEffect` (or `useSyncExternalStore` over the handle) |
| `@super-store/super-line` | **CRDT** pair (Yjs) | lives in the *super-store* repo; deps `@super-line/core`; wraps `StoreValue`; `clustering:'relay'` |

## 7. What's new vs reused (no breaking changes — additive)

**New (core):** `src/store.ts` interfaces; reserved store frames in `wire.ts`; `store.*` variants in
`InspectorEvent` (`src/inspector.ts:72`).

**New (server `packages/server/src/index.ts`):** a `stores?` option in `SuperLineServerOptions`
(after `inspector`, ~line 244); a `store(name)` accessor on `SuperLineServer` (after `forRole`, ~line 286)
implemented on the `api` literal (~line 1051) in the style of `room()`/`publish()`; a `STORE = 's:'`
channel prefix (~line 67) + a dispatch branch in `adapter.onMessage` (~line 372); store frame handling in
`onMessage`; the `principal = opts.identify?.(conn) ?? conn.id` fallback at the `acceptConn` identify
sites (~lines 711/725). **Reuses:** `joinChannel`/`members` channel machinery, `publishTo` fan-out,
`adapter` relay + `instanceId` echo-break, `safeSnapshot`/`inspectorRedact`, `emitInspectorEvent`.

**New (client `packages/client/src/index.ts`):** a `stores?` option in `SuperLineClientOptions`
(~line 110); a `store(name)` accessor on `SuperLineClient` + `base` object (~line 442); a store
re-snapshot loop in `onOpen` (after the topic re-subscribe at ~line 225). **Reuses:** request map,
listener routing, reconnect backoff, the logical-connection model.

**New (react):** `useResource` inside `createSuperLineHooks` (~line 47), exported from the return (~line 116).

**Unchanged:** `defineContract`, the typed request/event/topic spine, the Adapter, every transport,
`docs/guide/synced-state.md`'s pattern (it stays valid; the Store is the first-class alternative).

## 8. Delivery plan (incremental, TDD — red/green per slice)

1. **Core seam + principal fallback.** Add `src/store.ts` interfaces + store frames in `wire.ts`; add the
   `principal = identify(conn) ?? conn.id` fallback (exposed as e.g. `conn.principal`). *Acceptance:*
   types compile; unit test — a conn with no `identify` gets `conn.id`, with `identify` gets the key; full
   suite (254) green.
2. **`@super-line/store-memory` standalone (LWW pair).** `memoryStoreServer` (LWW `apply` replaces `data`;
   `onChange` fires; `clustering:'relay'`) + `memoryStoreClient` (replica = plain holder; `set` → full-value
   Change; `applyRemote` replaces unless own-origin). *Acceptance:* package unit tests — create/read/apply/
   onChange/setAccess/delete/list; replica set/applyRemote/own-origin echo-break. **No server involved.**
3. **Server wiring (single-node): option + `srv.store` + ACL + fan-out.** `stores` option; `srv.store.<name>`
   (create/read/write/grant/revoke/delete/list); store-frame dispatch (`sopen` → read-ACL + join channel +
   catch-up snapshot; `swr` → write-ACL + `store.apply`; `sclose`); `store.onChange` → publish to
   `s:<name>:<id>` skipping origin conn. *Acceptance:* integration — two clients open one Resource, one
   writes, the other receives; deny-by-default (`FORBIDDEN`/`NOT_FOUND`); grant/revoke; server co-writer.
4. **Client wiring: option + `client.store` + reactive handle + reconnect.** `stores` option;
   `client.store.<name>.open(id)` → handle driving `ResourceReplica` + the wire; `read`/`write` sugar;
   `onOpen` re-snapshot. *Acceptance:* loopback integration — `getSnapshot` fills after catch-up; `set`
   propagates; drop + reconnect re-snapshots.
5. **Cross-node (`relay`) + `self` passthrough.** Relay Changes over the adapter on the `STORE` channel;
   feed arriving Changes into the local store via `apply` (relay), `instanceId` echo-break; `self` stores
   skip the relay. *Acceptance:* multi-node via `MemoryBus` — write on node A, subscriber on node B
   receives; replicas converge.
6. **`store.*` inspector events + Control Center.** Add variants to `InspectorEvent`; emit from server
   send-sites (safe-snapshot + redact); map them in `control-center/src/lib/events.ts`
   (category/color/summary/payload/wire) + a **Store** tab in `components/live-feed.tsx`. *Acceptance:* CC
   `events.test.ts` cases + inspector integration (store ops surface; payloads redacted; cluster fan-out).
7. **`useResource` React hook.** Add to `createSuperLineHooks`, export. *Acceptance:* react test — returns
   the snapshot, re-renders on Change, unsubscribes on unmount.
8. **`@super-store/super-line` CRDT pair (in the super-store repo).** `crdtStoreServer`/`crdtStoreClient`
   wrapping `StoreValue`: `apply` = `Y.applyUpdate(delta)`; `onChange` = doc `'update'` observer → b64 delta
   + origin; replica wraps `StoreValue` (`set`/`update` → delta). *Acceptance:* the `synced-canvas` collab
   demo re-expressed on the Store (drag across two tabs; server nudge) converges, origin-attributed.
9. **Docs + example + positioning.** `docs/guide/store.md`; reframe `synced-state.md` as "the CRDT Store";
   an `examples/store-*` (a permissioned doc + the collab canvas on the Store); README — "persisted state"
   as a first-class capability. *Acceptance:* `docs:build` clean; example runs end-to-end.

Slices 1–7 ship the primitive + LWW + observability + React **inside super-line**; slice 8 is the CRDT
binding in the super-store repo; slice 9 is docs/examples. Slices are independently shippable.

## 9b. Built — deviations from the plan (2026-06-23)

All nine slices shipped on branch `feat/store` (306 tests green). Three things landed differently:

- **`store` is a method, not a property.** `srv.store(name)` / `client.store(name)` (returning a handle),
  not `srv.store.scene` — a `Record<string, …>` property trips `noUncheckedIndexedAccess` (possibly-undefined)
  at every call site. The method mirrors `room(name)` / `forRole(role)` and throws `NOT_FOUND` for an
  unconfigured name.
- **The CRDT pair is `@super-line/store-sync`, in *this* repo** (factories `syncStoreServer` /
  `syncStoreClient`) — not `@super-store/super-line` in the super-store repo. Decided once
  `@super-store/store` was published to npm: the binding deps the published engine + the workspace
  `@super-line/core` (where the store types live), so it builds with no cross-repo release coupling; Yjs
  stays confined to this one optional package.
- **Slice 9's example uses the LWW store** (`examples/store`, a permissioned note). The CRDT collab-canvas
  re-expression is left as follow-up; `store-sync`'s convergence (incl. concurrent per-field merge) is
  covered by its package tests.

## 9. Open items (logged in `CONTEXT.md`; not blocking the interface)

- **Durable persistence for `relay` replicas.** In-memory `relay` replicas are per-node/ephemeral; durable
  multi-node wants a `self` (shared-backend) store or per-node CRDT persistence. Define how a CRDT doc
  reconciles with any whole-JSON snapshot/content-version store.
- **Write-conflict semantics (LWW).** Concurrent multi-node writes to one Resource under `relay` race
  (last relayed wins; brief divergence). Document; steer durable multi-node to CRDT or `self`.
- **`list` shape.** One-shot ACL-filtered ids assumed; revisit if large collections need streaming/paging.
- **Undo surface.** super-store ships opt-in per-actor undo (tracks `STORE_ORIGIN` writes) — does the
  `crdtStore`/handle expose it, and how does it interact with the [Resource handle]?
- **Awareness/presence.** Cursors/selection/who's-editing — CRDT awareness vs super-line's existing
  presence directory.
- **Agent residency.** Server co-writers (AI agents) in-process vs separate worker/node peers.
