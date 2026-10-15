# PLAN — super-line on Cloudflare Workers: one Durable Object is one node

Host a super-line server inside a Durable Object (DO), reached over a hibernation-aware WebSocket
transport, with rows and CRDT docs on DO SQLite and the four first-party plugins running there. Locked
2026-10-14 in the cloudflare-workers wayfinder effort (`.scratch/cloudflare-workers/MAP.md`, tickets T01–T15).
ADRs: [0027](../adr/0027-a-connection-is-reconstructible-from-its-snapshot.md) (connection snapshot seam),
[0028](../adr/0028-liveness-belongs-to-the-transport.md) (transport-owned liveness).

## Destination

Built, tested, documented, release-staged:

- `@super-line/transport-cloudflare` — `ServerTransport` over the DO WebSocket Hibernation API, with a
  `fetch` router and a DO-class helper. Sockets survive eviction; the server resumes every subscription
  transparently on wake.
- Core/server/client seam: **connection snapshot** (ADR-0027), the `end` frame, transport-owned liveness
  (ADR-0028), the busy token.
- `@super-line/collections-cloudflare` (rows, typed tables ported from `collections-sqlite`) and
  `@super-line/collections-crdt-cloudflare` (CRDT docs, snapshot-per-doc) on DO SQLite.
- plugin-auth / plugin-inspector / plugin-chat / plugin-queue run under `nodejs_compat` (verification only).
- Third lane `pnpm test:workers` on `@cloudflare/vitest-plugin`; `pnpm test` = fast + heavy + workers.
- `examples/cloudflare` deployed once with `wrangler`.

Out of scope (fresh efforts, not fog): stateless Worker hosting; multi-DO clustering / a Cloudflare `Adapter`;
HTTP (SSE/long-poll) transport on Workers; forced reconnect as the wake strategy; **queue cron on DO alarms**
(a node running plugin-queue does not hibernate — its `setInterval` polls keep it awake; documented).

## Facts the design rests on

From the research (T01–T03) and the prototype (T04); every number has a source in the wayfinder assets.

- Hibernation starts after ~10 s with no event and **no timers, no unsettled `waitUntil`, no in-flight
  event**. The constructor reruns on wake, before the handler; in-memory state is gone.
- Socket attachment limit is **16 KiB**; a realistic subscription-heavy connection snapshot is 4–14 KB and a
  heavy one 36 KB → snapshots live in **DO SQLite keyed by connection id**; the attachment carries only the id.
- Protocol pings are answered without a wake; `setWebSocketAutoResponse(req, res)` answers one exact text
  message without a wake (2 KiB each).
- A hibernated single-node DO **cannot have changed** while hibernated: nothing runs. So resumption never
  re-snapshots rows or docs — the client's view is still current.
- `node:crypto` under `nodejs_compat` covers everything the plugins import (scrypt with options, hkdfSync,
  randomBytes, createHash, timingSafeEqual, Buffer).
- DO SQLite: 100 bound params per query, 100 columns per table, 2 MB per row, `transactionSync` only (no raw
  `BEGIN`/`SAVEPOINT`), no `journal_mode`/`synchronous` pragmas, a throw inside `blockConcurrencyWhile`
  resets the object.
- `ws` cannot be the DO transport (no `node:http` upgrade); the DO WebSocket tests need
  `--max-workers=1 --no-isolate`; `@cloudflare/vitest-plugin` needs vitest ≥ 4.1 (repo is on 4.1.11 as of
  `chore(deps): vitest 4`).
- The server already imports no `node:*`; `process.env.SUPER_LINE_NODE_NAME` is read behind `typeof process`.

## 1. The connection snapshot seam (core + server + client) — ADR-0027

The prototype's key simplification: **the snapshot is not the server's internal state**. Every per-connection
registry the server holds (`conn.channels`, row `connState`, CRDT `d:` membership, reserved-conn bridges) is
*derived* from frames the client sent. The snapshot is the authenticate outcome plus the client's live
subscribe frames; adopt is the ordinary accept path plus a replay with acks muted.

### Types (`@super-line/core`, `transport.ts`)

```ts
export interface ConnectionSnapshot {
  /** The AuthOutcome the connection was accepted with. `connectionId` is REQUIRED on this path. */
  auth: AuthOutcome & { connectionId: string }
  connectedAt: number
  /** Rooms joined by host handlers (`srv.room(r).add(conn)`); no frame reproduces these. */
  rooms: string[]
  /** The live subscribe set: `sub` / `csub` / `cdopen` frames, already net of `unsub` / `cuns` / `cdclose`. */
  frames: Array<SubFrame | CSubFrame | CDOpenFrame>
  /** Per-plugin opaque contributions, keyed by plugin name (absent when no plugin contributes). */
  plugins?: Record<string, unknown>
}

export interface ServerTransportHooks {            // the object passed to ServerTransport.start(hooks)
  authenticate(handshake: Handshake): Promise<AuthOutcome>
  onConnection(raw: RawConn, auth: AuthOutcome): void
  reserved?: ReservedConnection[]
  // NEW — the snapshot seam. All three are optional for the transport to use.
  /** Adopt a surviving socket on a fresh server instance: accept + rooms + muted replay + plugin restore. */
  adoptConnection(raw: RawConn, snapshot: ConnectionSnapshot): void
  /** The current snapshot of a live connection (undefined once it closed). */
  snapshotOf(connId: string): ConnectionSnapshot | undefined
}

export interface ServerTransport {
  start(hooks: ServerTransportHooks): void | Promise<void>
  stop(): void | Promise<void>
  // NEW — see §2 and §3
  liveness?: 'server' | 'socket'
  /** Push: called synchronously after any change to a connection's snapshot (subscribe, unsubscribe,
   *  room join/leave, plugin contribution). The transport persists it however it likes. */
  onSnapshotChanged?(connId: string, snapshot: ConnectionSnapshot): void
}
```

Push, not pull (Q11): the server fires `onSnapshotChanged` synchronously at the point of change; the DO
transport writes the row with a synchronous `sql.exec`, so the write lands before the handler returns and
can never race a hibernation. A transport without the hook pays nothing — the server keeps no snapshot
bookkeeping unless at least one started transport declares `onSnapshotChanged` or calls `snapshotOf`.

### Server semantics

- **Recording** happens where every subscribe already passes: `onMessage` for `sub`/`unsub`/`csub`/`cuns`/
  `cdopen`/`cdclose` (reserved conns included — `onReservedFrame` handles `sub`/`unsub` the same way) and
  `joinChannel`/`leaveChannel` for `r:` channels. A refused subscribe (policy denied, unknown collection) is
  **not** recorded — only successful ones.
- **`adoptConnection(raw, snapshot)`** = `acceptConn(raw, snapshot.auth)` with `connectedAt` carried over
  (not `Date.now()`), then `room(r).add(conn)` for each room, then **muted replay**: each stored frame is
  dispatched through the normal handler with a replay correlation id; the `res`/`err` for a replay id is
  swallowed. `onConnection` hooks fire as on a fresh accept (so a host may re-seed `conn.data`). The server
  re-sends the `env` frame as every accept does; the client treats it as last-write-wins, which doubles as a
  liveness confirmation.
- **Replay refusal** (policy now denies, collection gone, doc deleted): the swallowed `err` becomes an
  **`end` frame** to the client (§1.1). Nothing is silently dead.
- **Plugins**: `ServerPlugin` gains `snapshotConnection?(conn): unknown` (called on every snapshot change,
  result stored under the plugin's name) and `restoreConnection?(conn, data: unknown): void` (called after
  replay). No first-party plugin implements them in this effort; chat's streams use the busy token (§3).
- **`conn.data`** is not snapshotted (untyped host scratch, may be unserializable). `onConnection` reruns on
  adopt and may re-seed it. Documented.
- **`conn.env`** IS snapshotted. The doc-comment on `Conn.env` ("never persisted") refers to the cluster
  presence directory; a snapshot is server-private storage equivalent to memory. Reword the comment.
- **`connectionId`** is mandatory on the snapshot path: `acceptConn` already honours `auth.connectionId`
  (plugin-auth sets it to the session id); when absent, the server assigns one at accept and **writes it back
  into the snapshot's `auth`** so `toConn(id)` and presence survive a wake.
- `ctx` size: docs warn that `ctx`/`env` dominate small snapshots (plugin-auth's ctx with claims + sealed is
  ~600 bytes); hosts stuffing large claim sets pay per connection per wake.

### 1.1 The `end` frame (server → client, every transport)

```ts
export interface EndFrame {
  t: 'end'
  kind: 'topic' | 'collection' | 'doc'
  c?: string            // topic
  s?: number            // collection subscription id
  n?: string; id?: string  // doc
  code: SuperLineErrorCode
  m: string
}
```

Client routing: `collection` → the `LiveRowSet` is marked dead and `onStoreError('resubscribe', { collection })`
fires (the same sink a failed reconnect re-subscribe uses today); `doc` → the `DocHandle` likewise with
`{ collection, id }`; `topic` → `onError` with `kind: 'resubscribe'` and the topic name (a `Subscription` has
no error sink of its own). A non-Cloudflare server may send `end` too — it is the first way to end one
subscription without dropping the connection. Added to the client tap vocabulary as a `deliver` of `end`.

### 1.2 Replay correlation ids

Replayed frames get ids from a reserved range (≥ 2^30) that a client never uses (client ids count up from 1).
The server's muting checks the range, not a per-frame flag, so no frame type changes.

## 2. Liveness belongs to the transport — ADR-0028

- `ServerTransport.liveness?: 'server' | 'socket'` (default `'server'`). When **every** started transport
  declares `'socket'`, the server does not start its heartbeat timer, exactly as `heartbeat: false`. Mixed
  transports keep the timer (it only pings connections of server-liveness transports? — no: it pings all;
  a socket-liveness transport's conns answer harmlessly. Keep it simple: timer runs if any transport needs it).
- The DO transport installs `setWebSocketAutoResponse('{"t":"ping"}', '{"t":"pong"}')`, so a **client-sent
  ping** is answered without a wake. The server also learns to answer an inbound `{t:'ping'}` with
  `{t:'pong'}` on every transport (new `ClientFrame` member, trivial handler) so the client option works
  against a Node server too.
- Client option `keepalive?: number` (ms, default **off**): send `{t:'ping'}` every N ms while open; a missing
  `pong` within N ms → the transport closes with 1006 and the ordinary reconnect path runs. Today the client
  has no liveness of its own (it only answers server pings), so this is additive.
- Consequence on a hibernating node: `onHeartbeat` never fires and plugin-auth's `lastSeenAt` means
  "last wake". Documented in the Workers how-to and in plugin-auth's docs.
- Serializer caveat: auto-response matches exact text, so the pair is only installed when the server's
  serializer is the JSON default; a custom serializer disables the auto-response (the client keepalive then
  wakes the object, still correct, just not free).

## 3. Busy token (keeps a DO awake during plugin activity)

```ts
// PluginContext
hold(reason?: string): () => void   // release
```

The server counts outstanding holds; `ServerTransportHooks` gains `onHold?(count: number)`, fired on every
change. The DO transport maps "count > 0" to one `ctx.waitUntil(promise)` that resolves when the count returns
to 0 (max 15 min of platform wall time; after that the stream is lost anyway and `sweepStale` cleans up).
plugin-chat takes a hold on `startMessage` and releases it on settle (finalize/abort/forceAbort) — the one
existing per-connection state that is not frame-derived. On a Node server the hook is absent and `hold()` is
a counter nobody reads. Chat stream snapshot/restore stays fog (listed on the map as a later refinement).

## 4. `@super-line/transport-cloudflare`

```ts
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'

// worker entry
export default {
  fetch: (req, env) => routeToNode(req, env.NODE, { selectId: (req) => ... }),  // default: idFromName('super-line')
}

// the DO class
export class Node extends createDurableNode((ctx, env) => ({
  contract,
  // every createSuperLineServer option except `transports`; the helper supplies the DO transport
  nodeKey: ctx.id.toString(),                       // default — stable per object, satisfies plugin-auth
  nodeName: env.SUPER_LINE_NODE_NAME,               // optional
  authenticate, identify, plugins, policies,
  collections: cloudflareCollections(ctx.storage, contract.collections),
  crdtCollections: crdtCloudflareCollections(ctx.storage),
})) {}
```

- **Upgrade routing**: `fetch` on the DO handles the WebSocket upgrade: reads role/params from the URL query
  into a `Handshake` (`transport: 'cloudflare'`, `headers` from the request, `raw: request`), runs
  `hooks.authenticate`, rejects with **4401 after upgrade** for a reserved-subprotocol refusal and a plain
  401 response otherwise (the same dance `transport-websocket` does), then `ctx.acceptWebSocket(ws, [connId])`,
  `ws.serializeAttachment({ id: connId })`, and `hooks.onConnection(rawConn, auth)`.
- **Reserved connections** (inspector): subprotocol negotiation exactly as the ws transport (`reservedFor`).
- **Snapshot persistence**: `onSnapshotChanged` → `INSERT OR REPLACE INTO _sl_conn (id, snapshot) VALUES (?, ?)`
  (JSON text; synchronous). On close → `DELETE`. Table name is `_sl_conn` (not `_cf_`-prefixed; that prefix
  is reserved by the platform).
- **Wake**: the DO constructor builds the server (transport included), then inside `blockConcurrencyWhile`
  loops `ctx.getWebSockets()`, reads each attachment id, loads the snapshot row, and calls
  `hooks.adoptConnection(rawConn, snapshot)`. A socket with no snapshot row (lost write, deploy race) is
  closed with **4409** so the client reconnects — the internal fallback the map allows. Nothing in the
  constructor throws past `blockConcurrencyWhile` (a throw resets the object): adopt failures close that one
  socket and log.
- **RawConn over a hibernatable socket**: `send` → `ws.send`; `writable` = `readyState === OPEN`; `onMessage`
  / `onClose` are driven by the DO's `webSocketMessage` / `webSocketClose` / `webSocketError` handlers
  routed by the socket's tag; `close(code, reason)` → `ws.close`; `terminate` → `ws.close(1006)`. `onDrain`
  never fires (no backpressure signal on the platform).
- **Liveness**: `liveness: 'socket'`; auto-response pair installed when the serializer is JSON.
- **Busy token**: `onHold` → `waitUntil` as in §3.
- Peer-dep on core with a hand-written range; no dependency on `ws`.

## 5. `@super-line/collections-cloudflare` (rows) and `-crdt-cloudflare` (docs)

Rows: port `collections-sqlite`'s typed-table layer (`planColumns`, `col_<name>` tables, `col_meta`
fingerprints, exact-compilable query pushdown) onto `ctx.storage.sql`. Extract-vs-copy is decided while
building (T09): if the SQL text layer separates cleanly from the better-sqlite3 calls, extract it into
`collections-sqlite` as an internal module both backends import; otherwise copy. Design constraints:

- `transactionSync` is the only transaction; `conditionalApply`'s nested transaction becomes one
  `transactionSync` whose callback checks conditions then applies.
- Chunk `IN (...)` lists at 90 params; refuse collections with more than 98 planned columns at construction
  with a clear error.
- No pragmas; `RETURNING`/`NULLS LAST`/partial indexes are expected on SQLite 3.53 but verified in the
  workers lane and on the example deploy.
- **Drift refusal never throws in the constructor.** The backend is built lazily on first use; a
  fingerprint mismatch makes every collection operation (and so every affected request) fail with a readable
  `INTERNAL` error naming the collection and the fix (bump the collection name or migrate), instead of
  resetting the object. Additive optional columns auto-`ALTER` as sqlite does.
- Clustering `relay`, single node, so no adapter traffic ever happens; the backend still declares `relay`.

Docs: snapshot-per-doc like libsql — table `_sl_crdt (collection, id, state BLOB)`, debounced writes
(250 ms default), validate-before-commit on a scratch copy as every CRDT backend does, and a clear error when
a doc's encoded state exceeds the 2 MB row limit (documented ceiling). Op-log rejected: single node, nothing
to replicate to, compaction complexity for no benefit.

## 6. Plugins under `nodejs_compat`

Verification only (T02): one in-workerd test runs the real `plugin-auth` crypto functions (scrypt with
options, `hkdfSync`, `timingSafeEqual`, `randomBytes`, `Buffer` hex/base64url round-trips) and the inspector's
token compare. `nodejs_compat` is a documented hard requirement of the plugins on Workers. T08 is folded into
the workers-lane ticket.

## 7. Tests

- **Fast lane** (loopback): the seam. The T04 prototype's hibernating loopback is promoted to a test
  transport (`packages/transport-loopback` gains `createHibernatingLoopback()` used only by tests) and the
  prototype scenario becomes the contract: topics / rows / docs / requests / env resume with zero client
  lifecycle events; rooms resume; `end` frame on replay refusal; busy token counts; `keepalive` ping/pong.
- **Workers lane** (`vitest.workers.config.ts`, `cloudflareTest()` plugin, `--max-workers=1 --no-isolate`,
  imports the root `alias`): the three transport-neutral ws tests ported (handshake from query + bytes both
  ways; 401/4401 reject; reserved subprotocol accept), the hibernation trio (`evictDurableObject` then
  transparent resume; replay refusal emits `end`; an open chat stream keeps the object awake), the crypto
  verification, and the rows/docs backend conformance suites. Undocumented platform behaviour to pin here:
  eviction close code, message-vs-constructor interleave, `RETURNING`/`NULLS LAST` availability.
- `pnpm test` = fast + heavy + workers; CLAUDE.md Commands and Gotchas updated.

## 8. Example, docs, release

- `examples/cloudflare`: Worker + DO hosting auth + chat + inspector, `wrangler.jsonc` with `nodejs_compat`
  and `new_sqlite_classes`, a browser client, README walking `wrangler dev` and `wrangler deploy`. Deployed
  once; hibernation observed. Ask before any deploy that costs money.
- Docs: how-to "Host a node on Cloudflare Workers" (transport choice, hibernation semantics the host must
  know, `lastSeenAt` meaning, backends, limits, `ctx` size), backends guide updated, three package READMEs,
  root README mention, all four `skills/super-line/` files. No ADR/plan citations in any published text.
- Release wave: core/server/client minor (new optional surface: `ConnectionSnapshot`, `end`, `ping`/`pong`,
  `liveness`, `hold`), plugin-chat minor (holds), transport-loopback minor (hibernating variant), three new
  packages at 0.1.0; `chore(release)` + tags + root aggregate; push/publish only on the user's go.

## As built (T15, 2026-10-15) — deviations from the lock

The core half shipped smaller than §1–§3 specify. Each cut removes surface with no current caller:

- **No `snapshotOf` hook.** Push (`onSnapshotChanged`) is the only path; nothing ever pulled.
- **No plugin `snapshotConnection`/`restoreConnection`, no `plugins` field on `ConnectionSnapshot`.** Chat's only
  in-memory per-connection state uses the busy token instead, so the hook had no implementer and no test. It
  returns with the "chat stream snapshot/restore" fog item if that graduates.
- **`onHold(count)` is a `ServerTransport` member**, like `onSnapshotChanged` (§3 put it on the start hooks, which
  flow the other way).
- **The transport names the connection id**: it passes `auth.connectionId` (kept, else minted) to `onConnection`
  so it can tag its socket; the server needed no write-back.
- **A refused topic drops its client listeners**, as a denied subscribe already does, and reports `{ topic }`.
- **The hibernating loopback is a server test helper** (`packages/server/test/hibernating-loopback.ts`), not a
  `transport-loopback` export, so `transport-loopback` needs no release.
- `end` needed no client-tap vocabulary change: every inbound frame is already tapped as `frame`. The devtools
  panel labels it.

## As built (T07, 2026-10-15) — the Cloudflare half

- **The busy token is a pending timer, not `waitUntil`.** The Durable Object docs state `waitUntil` has no effect
  in an object (T01's research had it wrong); hibernation is blocked by a scheduled timer, so while any hold is
  outstanding the transport keeps one no-op `setInterval`. The object still goes from "idle, non-hibernatable"
  to evicted after 70–140 s with no incoming event, so a hold buys that much idle tolerance, not 15 minutes.
- **`adoptConnection` returns a promise** that settles once every replayed subscribe has; `resume()` awaits each
  inside `blockConcurrencyWhile`, so the event that woke the object never races a half-rebuilt connection.
- **`routeToNode(req, ns, { name })`** picks the object with `getByName` (the documented deterministic route)
  instead of a `selectId` returning an id.
- **`createDurableNode(build)`**: `build(ctx, env, base)` returns the server built with `...base`
  (`{ transports, nodeKey: ctx.id }`), so the host calls `createSuperLineServer` itself and keeps full typing; the
  class exposes `transport` and `server`.
- **The auto-response pair is installed unconditionally**: it can only match the JSON ping text, so a custom
  serializer's pings simply reach the server (waking it) — no serializer check needed.
- **Snapshot rows whose socket is gone are deleted on every resume** (a deploy drops sockets without close events).
- Close on refusal paths: reserved-class refusal is 4401 after the upgrade; `terminate()` sends 1011 (1006 cannot
  be sent by an endpoint); an un-resumable socket is closed with `CLOSE_NOT_RESUMABLE` (4409).
- Peer range on core is `>=0.20.0` for now; the release ticket raises it to the core minor that ships the seam.

## As built (T09, 2026-10-15) — rows on Durable Object SQLite

- **Extract, not copy.** The SQL text layer separated cleanly from the better-sqlite3 calls, so it moved to
  `collections-sqlite/src/sql.ts` (table/statement text, filter + order compilation, row encode/decode, fingerprint
  drift) and both backends run it. `collections-cloudflare` imports it by relative path and tsup **bundles** it —
  a dependency on `collections-sqlite` would install better-sqlite3, a native addon no Worker can load. Each
  backend keeps only its engine glue (~150 lines). `collections-sqlite` changed source, so it owes a patch release.
- **`cloudflareCollections(storage, collections)`**, positional as §4 sketched; no `close`.
- **Lazy, per-collection failure.** Nothing runs until the first operation. A collection that cannot open (non-additive
  drift, more than 98 planned columns, a bad name/index/schema) is recorded and fails *its own* operations with a
  `SuperLineError('INTERNAL', "cloudflareCollections: collection 'x' is unusable: …")` naming the fix (rename it, or
  migrate `col_x` and its `col_meta` row in code); every other collection works. Additive drift ALTERs in as sqlite does.
- **The 100-bound-value cap is not chunked in snapshots** — chunking `IN` cannot lower one statement's count. A
  filter needing more than 98 values (2 kept for LIMIT/OFFSET) scans the table and filters in JS (correct, the
  evaluator is authoritative). `rowMeta` does chunk, 100 ids per query.
- **`conditionalApply` is one `transactionSync`** that checks then applies. Nested `transactionSync` turned out to
  work in workerd, but nothing relies on it. A `SuperLineError` thrown inside keeps its identity and code.
- **Verified under workerd (Miniflare)**: `NULLS FIRST/LAST`, the 100-variable limit (`too many SQL variables`
  without the cap), a 98-column row (100 bound values). `RETURNING` is unused, so nothing to verify. A row over 2 MB
  fails with the platform's error, which the server masks to `INTERNAL` — a documented ceiling (T12), not wrapped.
- Tests: the shared row conformance suite plus sqlite's own pushdown checks run inside `runInDurableObject` via
  vitest 4.1's `aroundEach` (DO storage is bound to its object; using it from the test body throws "Cannot perform
  I/O on behalf of a different Durable Object"). End to end, `AppNode` now carries a `notes` collection: a live row
  subscription survives eviction and the woken node still has every row.

## As built (T10, 2026-10-15) — CRDT docs on Durable Object SQLite

- **`crdtCloudflareCollections(storage, collections, { debounceMs? })`** — synchronous, positional like the rows
  backend. It takes the contract's `collections` map (not libsql's `docOptions` callback) because a doc must be
  rebuilt with its collection's `DocOptions` on `read`, which receives none.
- **Lazy per doc, not rehydrate-all.** libsql rehydrates every doc in an async factory; here that would run on every
  wake. A doc loads from `_sl_crdt` on its first touch (`read`/`open`/`apply`/`create`), synchronously, since DO SQL
  is. The replay into the engine is suppressed from `onChange`, so a wake never re-broadcasts a full doc state to the
  adopted connections.
- **Debounced write-through, 250 ms**, as locked: per-keystroke full `encodeState` is the cost `crdt.validate: false`
  exists to avoid. A pending write is a timer, so it holds the object out of hibernation for that window; only a
  forced reset (deploy, crash, `evictDurableObject`) loses it. `create` writes immediately; `delete` cancels the
  pending write. `close()` flushes, for parity — nothing calls it inside a Durable Object.
- **`list` reads storage** (`id`, `created_at`, `updated_at` columns; filter/sort/page in SQL), so `createdAt`
  survives wakes and listing loads no docs. `updatedAt` lags a pending write by up to the debounce. Sorting by id is
  SQLite's byte order — identical to the memory backend's for ids without astral characters.
- **2 MB**: local workerd does not enforce the row limit (a 5 MB BLOB inserts fine), so the backend checks the
  encoded state itself: `create` throws `INTERNAL` "document n/id is N bytes, over the 2 MB a Durable Object row
  holds — split it into smaller documents"; an edit that grows a doc past it fails its write-through, is logged under
  `['super-line', 'collections-crdt-cloudflare']`, and every later write to that doc throws the same error (the
  writer resyncs) while storage keeps the last state that fit. The rows backend relies on the platform's own error,
  which therefore only shows on a real deploy.
- **State is a BLOB** (raw Yjs bytes, read back as `ArrayBuffer`) — a third more headroom than base64 TEXT.
- Tests: a shared CRDT conformance suite now exists (`collections-crdt-memory/test/crdt-store-conformance.ts`,
  extracted from the memory backend's tests, which now run through it) and runs inside `runInDurableObject`; plus
  durability across instances (Yjs history kept, so an old replica keeps merging), no fan-out on load, debounce,
  list, delete, the 2 MB refusal, a real eviction, and end to end: `AppNode` carries a `boards` CRDT collection —
  an open doc survives a wake and a write after it reaches every holder, zero client lifecycle events.

## As built (T11, 2026-10-15) — the example, deployed once

- **`examples/cloudflare`**: one `ChatNode` Durable Object (auth + chat + inspector, rows on `cloudflareCollections`), a
  vanilla-TS page built by Vite into `dist` and served as Workers static assets, `wrangler.jsonc` with `nodejs_compat`,
  `new_sqlite_classes` and `observability`. Scripts: `pnpm dev` (`vite build && wrangler dev`), `pnpm run deploy`
  (`pnpm deploy` is pnpm's own command), `pnpm tail`.
- **plugin-inspector held the node awake forever**: its watcher keepalive was an unconditional 2 s `setInterval`. It now
  runs only while a Control Center watches, here or on a peer. Measured under `wrangler dev`: with the old inspector an
  idle node never re-constructed; with the fix it hibernates and the next message wakes a new instance. plugin-inspector
  owes a patch release.
- **Only `/ws` reaches the node.** Every request a Durable Object receives wakes it; on the first deploy a stray
  `/favicon.ico` constructed the node. The Worker answers other paths with a 404 itself.
- `#general` is seeded inside the host's own `blockConcurrencyWhile` (runs before the resume one), and joining awaits
  that promise, because a wake re-runs `onConnection` for every adopted socket.
- **Deployed** to `https://<name>.<subdomain>.workers.dev`, verified, then deleted: two users signed up (scrypt, no CPU
  limit hit), chatted, idled 20 s — a new instance was constructed on the next message and delivery carried on with no
  reconnect; the inspector connected with the secret password, and a wrong one closed `4401`. The inspector's reserved
  connection also survives a wake (`wrangler dev`).
- Platform facts for the docs: `wrangler tail` shows hibernatable WebSocket events as `Unknown Event`, and a log line
  attaches to the event that triggered it, so a constructor log on a WebSocket upgrade prints when that socket closes;
  log redaction of query strings is heuristic — the 32-hex inspector password showed as `REDACTED`, a short one in
  clear, and the Control Center sends its credentials in the query string.

## As built (T16, 2026-10-15) — plugin-auth sessions and presence survive a wake

- **Found at T12, reproduced in the workers lane:** plugin-auth's boot sweep ended every unfinished session for its
  `nodeKey` — and a wake re-runs it while the sessions' sockets are being adopted, so every wake ended every live
  session. `lastSeenAt` only advanced on `onHeartbeat`, which a `liveness: 'socket'` transport never fires.
- **Adoption moved into `start()`.** The Cloudflare transport resumes from the promise `start()` returns (a microtask
  after the synchronous construction, so the host's handlers exist), so `srv.ready` now means "every surviving socket
  is back". `CloudflareServerTransport.resume()` is gone (never published); `createDurableNode` and a hand-written
  class just `blockConcurrencyWhile(() => server.ready)`. Corollary: a host's own `blockConcurrencyWhile` that awaits
  `server.ready` (the example's `#general` seed) now runs after the resume, not before — harmless, and the docs no
  longer claim otherwise.
- **`PluginContext.ready`** (= `srv.ready`). plugin-auth's sweep awaits it and spares every session whose id is a
  live connection (`connectionId === sessionId`). Steady-state wake = zero session/presence writes. A socket that
  didn't come back (4409) keeps its session open until the sweep, which then ends it.
- **Presence is opt-in "trust the socket"** (decided with the user over a server-declared `expiresAt` column):
  `chatClient({ presenceTimeoutMs: Infinity })` reads an open session as online; `endSession` stamps the close time
  when no pong was ever seen (`lastPongAt ?? now`), so "last seen" is the disconnect, not the connect. Unverified and
  documented as such: how long Cloudflare takes to report a vanished client's socket closed.

## Ticket order after the lock

T15 seam on loopback → T06 workers lane (+ crypto verification) → T07 DO transport → T09 rows → T10 docs →
T11 example → T12 docs/skills → T13 release.
