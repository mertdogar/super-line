# super-line — API reference

Exact public surface. Signatures verified against source. `C` is the contract type, `R` a role (`keyof C['roles']`). `ctx` is whatever `authenticate` returns for that role.

## @super-line/core

```ts
defineContract(<const C>): C                 // identity; preserves literal keys + `subscribe: true`
// contract shape:
{
  shared?: {
    clientToServer?: Record<string, { input: Schema; output: Schema }>   // requests
    serverToClient?: Record<string, ServerEntry>                          // event | topic | server→client request
  }
  roles: Record<string, {                    // at least one role
    data?: Schema                            // optional: types this role's mutable conn.data
    clientToServer?: Record<string, { input: Schema; output: Schema }>
    serverToClient?: Record<string, ServerEntry>
  }>
}
// Cluster event bus: a bus channel is just a SHARED topic
// ({ payload, subscribe: true } under shared.serverToClient). One publish fans out to
// same-node server.subscribe listeners, other nodes' server.subscribe listeners, AND subscribed clients.
// ServerEntry (serverToClient): { payload } => push event; { payload, subscribe: true } => topic;
//                               { input, output } => server→client request (client answers via client.implement)
// A role's effective surface = shared ∪ roles[R].
// Schema = any StandardSchemaV1 validator (Zod, Valibot, ArkType…). Zod in examples.

validate(schema, value): Promise<Output>     // async-capable; throws SuperLineError('VALIDATION')
validateSync(schema, value): Output          // sync; throws on async schemas

class SuperLineError<Data> extends Error { code: ErrorCode; data?: Data
  constructor(code, message?, data?) }
// SuperLineErrorCode: BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | TIMEOUT | VALIDATION | DISCONNECTED | INTERNAL
// ErrorCode = SuperLineErrorCode | (string & {})  -> custom codes allowed

jsonSerializer: Serializer                   // default
interface Serializer { encode(v): string|Uint8Array; decode(d: string|Uint8Array): unknown }

interface Adapter {                          // cross-node fan-out seam
  subscribe(channel): void|Promise<void>
  unsubscribe(channel): void|Promise<void>
  publish(channel, payload: string|Uint8Array): void|Promise<void>
  onMessage(cb: (channel, payload) => void): void
  close?(): void|Promise<void>
  presence?: PresenceStore                   // optional: powers srv.cluster.* / isOnline (in-memory + redis have it)
}
// PresenceStore: set/del/beat/clearNode + addRoom/removeRoom + list/get/byUser/roomMembers/count/topology
// ConnDescriptor { id, role, nodeId, connectedAt, userId?, rooms, [extra] }; NodeStat { nodeId, connections, rooms, alive }

// contract type: Contract, Directional, RoleBlock, RequestDef, ServerMessageDef, ServerRequestDef, ServerEntry, Schema
// surface helpers: RoleOf<C>, Requests<C,R>, ServerMessages<C,R>, Events<C,R>, Topics<C,R>,
//   SharedRequests<C>, RoleRequests<C,R>, SharedEvents<C>, SharedTopics<C>, RoleTopics<C,R>,
//   ServerRequests<C,R>, SharedServerRequests<C>, DataOf<C,R>, AnyData<C>
// presence: PresenceStore, ConnDescriptor, NodeStat
// transport interfaces: RawConn, Handshake, AuthOutcome, ServerTransport, ClientTransport, PingFrame, PongFrame
//   (the WS transport is @super-line/transport-websocket; HTTP/SSE + libp2p transports are separate packages)
// extractors (guarded): ClientInput<T>, ServerInput<T>, Output<T>, EventData<T>, EmitData<T>
// InferIn<S>, InferOut<S>
```

## @super-line/server

```ts
createSuperLineServer<C, A extends AuthResult<C>>(contract: C, opts: SuperLineServerOptions<C, A>): SuperLineServer<C, A>
// A is inferred from authenticate's return — the discriminated { role, ctx } union.

type AuthResult<C> = { [R in keyof C['roles']]: { role: R; ctx: unknown } }[keyof C['roles']]

interface SuperLineServerOptions<C, A> {
  transports: ServerTransport[]               // REQUIRED. e.g. [webSocketServerTransport({ server })] from @super-line/transport-websocket
  serializer?: Serializer                     // default jsonSerializer; MUST match the client
  adapter?: Adapter                           // default: per-server in-memory; use redis for multi-node
  authenticate: (h: Handshake) => A | Promise<A>   // REQUIRED. Return { role, ctx }; throw -> 401. h = { transport, headers, query, peer?, raw }
  authorizeSubscribe?: (topic, ctx, conn) => boolean | void | Promise<boolean | void> // false/throw -> deny
  use?: Middleware<A>[]                        // run before request/subscribe handlers
  onConnection?: (conn, ctx) => void           // runs just BEFORE the presence snapshot (seed conn.data here)
  onDisconnect?: (conn, ctx, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo) => void
  identify?: (conn) => string | undefined      // stable user key -> cluster.byUser / isOnline / toUser
  describeConn?: (conn) => Record<string, unknown>  // extra fields merged into the cluster descriptor (ctx never auto-serialized)
  heartbeat?: { interval?: number; maxMissed?: number } | false  // default { interval: 30_000 }; maxMissed -> reap
  collections?: CollectionStore                // ONE row-collection backend for ALL row collections (single tx domain → atomic cross-collection batches). See Collections.
  crdtCollections?: CrdtCollectionStore        // SEPARATE backend for CRDT document collections (never joins a cross-collection batch). See CRDT document collections.
  policies?: Record<string, CollectionPolicy>  // per-collection access; DENY-BY-DEFAULT (omit read/write ⇒ that op is server-only). Row shape (read→IR filter) vs CRDT guard shape (read/write→bool).
  checkReferences?: boolean                    // opt-in advisory FK existence check on row writes (no cascades)
  plugins?: SuperLinePlugin[]                  // runtime plugins: inspector() (Control Center), authKit.plugin (@super-line/plugin-auth), your own
}
// path + backpressure now live on the transport: webSocketServerTransport({ server, path, backpressure })
// The Backpressure type lives in @super-line/transport-websocket (no longer in @super-line/server).
// Handshake (from @super-line/core): { transport, headers, query: Record<string,string>, peer?, raw } — raw is the escape hatch (IncomingMessage for WS).

interface SuperLineServer<C, A> {
  readonly nodeId: string                                            // this process's stable id
  implement(handlers: Handlers<C, A>): SuperLineServer<C, A>             // chainable
  room(name: string): Room<C>                                        // mixed-role group
  publish<T extends keyof SharedTopics<C>>(topic: T, data): void      // SHARED topics — cluster event bus: fans out to server.subscribe (this + other nodes) AND subscribed clients
  forRole<R>(role: R): { publish<T extends keyof RoleTopics<C,R>>(topic: T, data): void }  // role topics
  subscribe<T extends keyof SharedTopics<C>>(topic: T, cb: (data, meta: { from: string }) => void): () => void  // SHARED topics only; server-side, cluster-wide; returns unsubscribe
  // server.subscribe fires for a publish from ANY node INCLUDING this one (local echo, in-process, NO Redis/WS hop).
  // meta.from = origin node id; self-exclude with: if (from === srv.nodeId) return. Role-scoped server.subscribe is deferred.
  // introspection
  readonly local: LocalView                                          // sync, THIS node
  readonly cluster: ClusterView                                      // async, registry-backed (needs presence adapter)
  isOnline(userId: string): Promise<boolean>                          // any live conn for this user key?
  // targeted cross-node send (no registry lookup on the delivery path)
  toConn(id: string): ConnTarget<C>                                  // one connection, any node
  toUser(userId: string): UserTarget<C>                              // all of a user's connections, any node
  collection(name: string): ServerCollectionHandle                   // server-authoritative: co-write rows (insert/update/delete/read/snapshot) or create+open CRDT docs; typed by the contract. See Collections.
  close(): Promise<void>                                              // idempotent; closes conns + cleans registry + adapter + ws
}

interface LocalView {                                                // synchronous, this node
  readonly connections: Conn[]
  readonly rooms: string[]
  readonly topics: string[]
}
interface ClusterView {                                              // async; rejects if the adapter has no presence
  connections(): Promise<ConnDescriptor[]>
  count(): Promise<number>
  byUser(userId: string): Promise<ConnDescriptor[]>
  room(name: string): Promise<ConnDescriptor[]>
  topology(): Promise<NodeStat[]>                                    // [{ nodeId, connections, rooms, alive }]
}
interface ConnTarget<C> {                                            // single, unambiguous target
  emit<E extends keyof SharedEvents<C>>(event: E, data): void        // shared events only
  request<M extends keyof SharedServerRequests<C>>(name: M, input, opts?: { timeout?: number; signal?: AbortSignal }): Promise<output>
  close(): void                                                      // cross-node kick
}
interface UserTarget<C> {                                            // 0..N devices — NO request() (ambiguous)
  emit<E extends keyof SharedEvents<C>>(event: E, data): void
  disconnect(): void
}
// ConnDescriptor: serializable snapshot (NOT a live Conn). { id, role, nodeId, connectedAt, userId?, rooms, ...describeConn }
// lastPongAt is node-local and NOT in the registry. Snapshot is taken at connect (seed via onConnection).

// handler map mirrors the contract: { shared?, [role]: {...} }
// `shared` key is required only if the contract has shared requests; otherwise omit it.
Handlers<C, A> = { shared: { [K in keyof SharedRequests<C>]: SharedHandler } }   // (present only when non-empty)
              & { [R in keyof C['roles']]: { [K in keyof RoleRequests<C,R>]: RoleHandler } }
// RoleHandler:   (input: InferOut<input>, ctx: <role ctx>,            conn: Conn</role events/, roleCtx, R>) => Awaitable<InferOut<output>>
// SharedHandler: (input: InferOut<input>, ctx: <union of role ctx>,   conn: Conn<shared events, ctxUnion, role union>) => Awaitable<InferOut<output>>

interface Room<C> {
  add(conn: Conn): void                        // any role (mixed membership)
  remove(conn: Conn): void
  broadcast<E extends keyof SharedEvents<C>>(event: E, data): void  // SHARED events only
  readonly size: number                        // LOCAL member count on this node
}

type Middleware<A> = (ctx, info: MiddlewareInfo, next: () => Promise<void>) => void|Promise<void>
interface MiddlewareInfo { kind: 'request' | 'subscribe'; name: string; conn: Conn }
// call next() to proceed; throw to short-circuit (reject).

class Conn<Ev, Ctx, Role, Data = unknown> {
  readonly id: string                          // server-assigned unique id (stable for life)
  readonly role: Role                          // this connection's role (typed literal)
  readonly ctx: Ctx
  readonly connectedAt: number                 // Date.now() at the upgrade
  lastPongAt?: number                          // last heartbeat pong (liveness) — node-local
  lastPingAt?: number                          // last heartbeat ping sent
  data: Data                                   // mutable per-conn state, typed per role (contract `data` schema); starts {}
  readonly channels: Set<string>
  send(frame): void                            // internal frame (you rarely call this)
  sendRaw(payload): void
  emit<E extends keyof Ev>(event: E, data): void   // push an event to THIS conn (node-local, role-scoped)
  close(): void
  terminate(): void                            // abruptly drop the underlying transport
}
// conn.terminate() abruptly drops the connection — handy in tests to simulate a network drop. (conn.ws is removed.)

// also exported: MemoryBus, createInMemoryAdapter (share one MemoryBus across servers to simulate nodes)
createInMemoryAdapter(bus?: MemoryBus): Adapter
```

Notes:
- Dispatch resolves a handler by `conn.role`, which inherently enforces the boundary: a request not on `shared ∪ roles[conn.role]` returns **`NOT_FOUND`** (does not reveal other roles' surface).
- `room.size` is the count on the *current node* only. A "room" and a "topic" share the same channel substrate; the difference is who subscribes (server `add` vs client `subscribe`).
- Role topics are namespaced per role on the wire; the client subscribes by the plain topic name.
- Cluster event bus (`server.publish` + `server.subscribe` on a shared topic): same-node listeners fire directly in-process (local echo, trusted, NOT re-validated); other nodes' listeners fire via the adapter (inbound payload validated against the topic schema). A throwing listener or a bad inbound payload routes to `opts.onError(err, { kind: 'event', name })`; each listener is isolated — one throw never stops the others or the message pump. Self-exclude with `if (from === srv.nodeId) return`.
- The bus is OPT-IN pub/sub. It's distinct from server-CHOSEN **events** (`conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit`) — those have no client opt-in and no server-side subscribe. Different tools; both exist.

## @super-line/client

```ts
createSuperLineClient<C, R extends keyof C['roles']>(contract: C, opts: SuperLineClientOptions<C, R>): SuperLineClient<C, R>

interface SuperLineClientOptions<C, R> {
  transport: ClientTransport                   // REQUIRED. e.g. webSocketClientTransport({ url }) from @super-line/transport-websocket
  role: R                                      // REQUIRED: narrows the surface AND is sent to the server to verify
  params?: Record<string, string>             // appended as query string (read in authenticate via h.query); `role` is added automatically
  serializer?: Serializer                       // MUST match the server
  timeoutMs?: number                            // default 30000
  validate?: 'off' | 'inbound'                  // default 'off'; 'inbound' re-validates server->client (catch drift)
  onValidationError?: (error, info: { kind: 'response'|'event'|'topic'; name }) => void
  reconnect?: boolean                           // default true
  reconnectBaseMs?: number                      // default 500
  reconnectMaxMs?: number                       // default 30000
  reconnectFactor?: number                      // default 2
  crdtCollections?: CrdtCollectionClient       // universal client CRDT engine — `crdtCollectionsClient()`; REQUIRED to open any CRDT document collection. Row collections need no client backend (driven by the contract + server).
  onStoreError?: (error, info: { store: string; id: string }) => void   // a rejected CRDT-doc write (schema/policy); the client then hard-resyncs its replica
}
// url + a custom WebSocket impl now live on the transport: webSocketClientTransport({ url, WebSocket }).
// Other transports (HTTP/SSE, libp2p) are available — see the Transports guide.

// SuperLineClient<C, R> is a typed proxy narrowed to role R's effective surface (shared ∪ R):
type SuperLineClient<C, R> = {
  [K in keyof Requests<C, R>]: (input, opts?: CallOptions) => Promise<output>  // throws SuperLineError
} & {
  on<E extends keyof Events<C, R>>(event: E, handler: (data) => void): () => void   // returns unsubscribe
  subscribe<T extends keyof Topics<C, R>>(topic: T, handler: (data) => void): Subscription
  implement(handlers: { [K in keyof ServerRequests<C, R>]?: (input) => Awaitable<output> }): void  // answer server→client requests; throw SuperLineError for typed failure
  collection(name: string): CollectionHandle | DocHandle   // typed by the contract: a row collection → query handle (subscribe/insert/update/delete/batch); a CRDT collection → open-by-id DocHandle. See Collections.
  close(): void
  readonly connected: boolean
  readonly role: R
}

interface CallOptions { timeoutMs?: number; signal?: AbortSignal }
interface Subscription { readonly ready: Promise<void>; unsubscribe(): void }  // ready rejects if denied/disconnected

backoffDelay(attempt, { baseMs, maxMs, factor }): number   // exponential + full jitter (exported util)
```

Client behavior:
- Auto-reconnect (backoff + jitter); topics auto-re-subscribe on reconnect.
- In-flight requests reject `DISCONNECTED` on drop; calls made while reconnecting are queued and flushed.
- At-most-once: messages sent while offline are not replayed.

## Transports (client↔server wire — pluggable)

Pass to `transports: [...]` (server) / `transport:` (client). WebSocket is the default; the others are drop-in alternatives. `RawConn`/`ServerTransport`/`ClientTransport`/`Handshake`/`AuthOutcome` are core types.

```ts
// @super-line/transport-websocket — default
webSocketServerTransport(opts?: { server?; path?; backpressure? }): ServerTransport   // inspector is now a plugin — plugins: [inspector()], not a transport option
webSocketClientTransport(opts: { url: string; WebSocket?: typeof WebSocket }): ClientTransport
wsServerRawConn(ws, backpressure?): RawConn        // adopt a raw ws (e.g. attach to an existing server)

// @super-line/transport-http — SSE downstream + POST upstream, or long-poll; mounts on an http.Server
httpServerTransport(opts: { server: http.Server; basePath?; sessionTimeout?; keepalive?; pollTimeout?; maxBodyBytes?; cors?: { origin? } }): ServerTransport
httpClientTransport(opts: { url: string; basePath?; mode?: 'sse' | 'longpoll'; EventSource?; fetch? }): ClientTransport

// @super-line/transport-libp2p — BYO started libp2p node (transport + noise + yamux); see the libp2p-nat example
libp2pServerTransport(opts: { node: Libp2p; protocol?: string }): ServerTransport
libp2pClientTransport(opts: { node: Libp2p; multiaddr: Multiaddr | Multiaddr[] | PeerId; protocol?: string; dialTimeoutMs?: number }): ClientTransport

// @super-line/transport-loopback — in-memory, zero-dependency, for tests
createLoopbackTransport(): { server: ServerTransport; client(): ClientTransport }
```

## Adapters (server↔server fan-out — pluggable)

```ts
// @super-line/adapter-redis
createRedisAdapter(options?: { url?: string; presenceTtlMs?: number } | string): Adapter
// createRedisAdapter('redis://localhost:6379')  — pass to every server's `adapter`
// presenceTtlMs (default 90_000): node liveness key TTL, refreshed by the heartbeat; must exceed heartbeat interval

// @super-line/adapter-libp2p — broker-less gossipsub mesh (BYO node OR a built-in one); presence via gossip
// discovery: 'mdns' (LAN/docker) | { mdns } | { bootstrap: [multiaddr] } | { relay: multiaddr } | array; omit = none
createLibp2pAdapter(opts?: { node?; discovery?; listen?; transport?; identity?; topic?; presence? }): Promise<Adapter & { node }>
createRelayNode(opts?: { port?; listen?; identity?; topic?; relay? }): Promise<Libp2p>  // public rendezvous node for { relay }

// @super-line/adapter-rabbitmq — one durable `direct` exchange; per-node exclusive queue
createRabbitmqAdapter(opts?: { url?; connection?; exchange?; queuePrefix?; presence? } | string): Promise<Adapter & { connection }>

// @super-line/adapter-zeromq — brokerless mesh / central proxy / BYO sockets
createZeroMqAdapter(opts: { bind; peers? } | { mode: 'proxy'; frontendUrl; backendUrl } | { pub; sub }): Promise<Adapter>
```
Redis: Pub/Sub (two connections) + a presence store. All adapters are at-most-once. Run more than one server process? Every server needs an adapter (the SAME backend). They carry rooms, topics (including cluster-bus `server.publish`/`server.subscribe`), targeted `toConn`/`toUser` sends, server→client request replies, change/delete fan-out for `relay` collection backends, AND the cluster presence registry (redis/libp2p/rabbitmq/zeromq all ship a `PresenceStore`).

## @super-line/react

```ts
createSuperLineHooks<C, R extends keyof C['roles']>(): {
  Provider: ({ client: SuperLineClient<C, R>; children }) => ReactNode
  useClient(): SuperLineClient<C, R>
  useEvent<E extends keyof Events<C, R>>(event: E, handler: (data) => void): void
  useSubscription<T extends keyof Topics<C, R>>(topic: T): data | undefined  // latest value
  useRequest<M extends keyof Requests<C, R>>(method: M): {
    data?; error?: unknown; isLoading: boolean
    call: (input) => Promise<output>
  }
  useCollection<N>(name: N, query?: CollectionQuery): {   // live row-set for a ROW collection; subscribes + closes on unmount
    rows: RowOf<C, N>[]                                    // current rows, ordered + limited by the query
    insert: (row: RowOf<C, N>) => Promise<void>
    update: (row: RowOf<C, N>) => Promise<void>
    delete: (id: string) => Promise<void>
  }
  useDoc<N>(name: N, id: string): {                        // open a CRDT DOCUMENT by id; closes on unmount
    data: SnapshotOf<C, N> | undefined                     // undefined until ready
    deleted: boolean                                       // true once the doc is deleted server-side
    set: (value) => void                                   // whole-doc replace
    update: (partial) => void                              // merge keys
    delete: (path: (string | number)[]) => void            // surgical key removal
  }
}
```
Create the client once (e.g. `useState(() => createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user' }))`, `webSocketClientTransport` from `@super-line/transport-websocket`), wrap with `<Provider client={client}>`, then use the hooks inside.

## Collections (typed rows)

Collections are super-line's **typed, on-contract** persisted state: named sets of **rows**, each schema-validated. super-line is the server-authoritative **sync source**; **TanStack DB is the client query engine** (joins/live-queries/optimism) via `@super-line/tanstack-db`. Rows are declared IN the contract, so the server validates every write and types flow end-to-end (`RowOf<C,N>`). Deletion/routing is filter-based, not per-id channels.

```ts
// CONTRACT — a top-level `collections` block (rows flow end-to-end via RowOf<C,N>):
defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string() }), key: 'id', references: { authorId: 'users' } },
  },
  roles: { /* … */ },
})

// SERVER — ONE backend serves all collections (single tx domain → atomic cross-collection batches) + row policies:
createSuperLineServer(api, {
  collections: memoryCollections(),            // or sqliteCollections({ file, collections: api.collections }) (relay) · await pgliteCollections({ pgUrl, electricUrl?, collections: api.collections }) (self)
  checkReferences: true,                        // opt-in advisory FK existence check (no cascades)
  policies: {                                   // DENY-BY-DEFAULT: omit read/write ⇒ that op is server-only
    messages: {
      read: (principal, ctx) => isIn('channelId', ctx.channels),  // → IR filter ANDed into every snapshot + live change; return undefined = whole collection
      write: (principal, op, next, prev) => op === 'delete' ? prev?.authorId === principal : next?.authorId === principal,
    },
  },
})
srv.collection('messages').insert/update/delete/read/snapshot   // server co-write: policy-free, schema-validated

// CLIENT — client.collection(name), typed by the contract:
const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general'), orderBy: [{ field: 'createdAt', dir: 'asc' }], limit: 50 })
await sub.ready                                 // AWAIT before depending on live delivery (frames process concurrently)
sub.rows()                                      // current rows, ordered + limited
sub.subscribe((ev) => {})                       // { type: 'insert'|'update'|'delete', id, row } — NON-optimistic (optimism is TanStack's job)
await client.collection('messages').insert(row) // also update(row) / delete(id) / batch([{type,row}|{type:'delete',id}]) — atomic
// React: const { rows, insert, update, delete: del } = useCollection('messages', { filter: eq('channelId', id) })

// QUERY IR (from @super-line/core) — one evaluator shared by routing/snapshots/client re-filter:
and/or/not · eq/neq/lt/lte/gt/gte(field, value) · isIn(field, values) · like/ilike(field, pattern)   // field = dot path
type CollectionQuery = { filter?: Expr; orderBy?: { field, dir: 'asc'|'desc' }[]; limit?; offset? }

// TANSTACK DB adapter — the query engine (joins, live queries):
import { createCollection, createLiveQueryCollection, eq as teq } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
const messages = createCollection(superLineCollectionOptions(client, api, 'messages', { query: { filter: eq('channelId', 'general') } }))
const users = createCollection(superLineCollectionOptions(client, api, 'users'))
createLiveQueryCollection((q) => q.from({ m: messages }).join({ u: users }, ({ m, u }) => teq(u.id, m.authorId), 'inner').select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })))
```

Backends (all drop-in, one line to swap): `@super-line/collections-memory` (in-memory · relay) · `collections-sqlite` (SQLite · relay, IR→SQL snapshot pushdown) · `collections-pglite` (central Postgres + Electric→PGlite · **self**, no adapter). Inspector: `listCollections` / `queryCollection` + a Control Center **Collections** view (schema graph + row browser). Guide: `docs/collections/`; example: `examples/collections`.

### CRDT document collections

A collection has **two consistency models** — LWW **rows** (above, queryable) and CRDT **docs** (whole-document merge, opened by id). A CRDT collection is declared with a `crdt` key (**no `key`** — the id is external) and is **opened by id, not queried**.

```ts
// CONTRACT — the `crdt` key discriminates (DocOptions: { mode?: 'shallow'|'document'; opaque?: string[] }):
defineContract({ collections: { scenes: { schema: z.object({ shapes: z.record(z.any()) }), crdt: { mode: 'document' } } } })

// SERVER — a SEPARATE backend (crdtCollections:, NOT collections:) + guard-shaped policies (deny-by-default):
createSuperLineServer(api, {
  crdtCollections: crdtMemoryCollections(),           // relay · in-memory (ships the universal crdtCollectionsClient)
  //             or await crdtLibsqlCollections({ url, authToken?, table?, debounceMs?, docOptions? })  // durable · relay (libsql/Turso)
  policies: { scenes: { read: (principal, id, snapshot?) => true, write: (principal, id) => true } },  // guard shape, NOT the RLS filter
})
await srv.collection('scenes').create(id, data)       // creation is SERVER-authoritative; clients open EXISTING docs (nonexistent → NOT_FOUND)
const co = srv.collection('scenes').open(id, { origin? })  // reactive server co-writer: getSnapshot/subscribe/set/update/delete(path)/close

// CLIENT — needs crdtCollections: crdtCollectionsClient() (the universal client engine, any tier):
const doc = client.collection('scenes').open(id)      // → DocHandle { getSnapshot, subscribe, set, update, delete(path), deleted, ready, close }
await doc.ready
// React: const { data, set, update, delete: del, deleted } = useDoc('scenes', id)
```

- **Validate-before-commit** — CRDT deltas ARE schema-validated. The ingress node merges each delta onto a scratch copy, snapshots to plaintext, validates against the contract schema, then commits + fans out **only if valid**; relay nodes trust the already-validated relayed delta. So a CRDT doc is schema-enforced end-to-end.
- **Reject → resync.** A rejected write (schema or write-policy) was applied optimistically, so the client re-opens and hard-**resets** its replica to authoritative, discarding the bad edit (`onStoreError` still fires). Validation runs on the **post-merge** state, so keep CRDT schemas to per-field/structural rules — an aggregate/cross-field constraint (maxItems, sum-of-fields) can reject a valid-looking concurrent write; put those in requests.
- Access = guard-shaped `CrdtCollectionPolicy` (`read(principal,id,snapshot?)→bool`, `write(principal,id)→bool`), deny-by-default — NOT the RLS filter shape LWW rows use. Wire: per-doc channel `d:<n>:<id>`, frames `cdopen/cdwr/cdchg/cddel/cdclose`.
- Backends: `collections-crdt-memory` (relay + the universal `crdtCollectionsClient`) · `collections-crdt-libsql` (durable · relay, `await crdtLibsqlCollections`, snapshot-per-doc) · `collections-crdt-pglite` (**self**: `await crdtPgliteCollections({ pgUrl, electricUrl?, docOptions? })` — central Postgres Yjs op-log + per-node Electric→PGlite replica, validate-before-commit at ingress, no adapter). Inspector surfaces them in `listCollections` (synthetic `id` key) + `queryCollection` synthesizes `{ id, ...snapshot }` doc-rows (browsable in the Control Center Collections view). Guide: `docs/collections/crdt-documents.md`; example: `examples/ai-canvas`.

## @super-line/plugin-auth

First-party authentication as a **paired plugin** — a contract fragment + a runtime server plugin + a client. Subpath exports: `.` (contract half), `/server`, `/client`, `/react`. Identity lives in collections (`users` public; `credentials`/`sessions`/`apiKeys`/`passwordResets` deny-all). Only the `guest` role is hardcoded; every other role is data-driven from the user's `roles[]`.

```ts
// . (contract half)
authContract(): ContractPlugin        // merges the `guest` role + the identity collections + the shared/guest auth requests INTO the contract
GUEST_ROLE = 'guest'
// schemas + types: userSchema/credentialSchema/sessionSchema/apiKeySchema/passwordResetSchema;
//   AuthUser, AuthCredential, AuthSession, AuthApiKey, AuthContext { userId: string|null; roles: string[]; sessionId: string|null }

// /server — the factory is `auth`; bind the result to `authKit`
auth<C>(opts: AuthServerOptions<C>): AuthServer<C>
interface AuthServerOptions<C> {
  contract: C
  collections: CollectionStore          // MUST be the SAME store instance passed to createSuperLineServer
  defaultRoles?: string[]               // default ['user']; must be contract roles
  sessionTtlMs?: number                 // default 30 days
  usersReadable?: boolean               // default true (open read on `users`)
  jwt?: { secret: string; ttlMs?: number }   // enables getToken + stateless ?jwt= connect; ttl default 15 min
  sendPasswordReset?: (a: { user: AuthUser; token: string }) => void | Promise<void>
  passwordResetTtlMs?: number           // default 1 hour
}
interface AuthServer<C> {
  authenticate: (h: Handshake) => Promise<AuthResult<C>>   // → { role, ctx: { userId, roles, sessionId } }
  identify: (conn) => string | undefined                   // principal = ctx.userId
  plugin: SuperLinePlugin                                  // runtime half: auth handlers + row policies for the identity collections
  revoke: (userId: string) => Promise<void>               // delete the user's sessions + toUser(userId).disconnect() cluster-wide
}

// /client
authClient<C, R>(opts: AuthClientOptions<C, R>): AuthClient<C, R>
interface AuthClientOptions<C, R> {
  authedRole: R
  connect: (a: { role: string; params: Record<string, string> }) => SuperLineClient<C, R>   // build a client for the given role + params
  storage?: TokenStorage                // default localStorage key 'superline.auth.token'
}
interface AuthClient<C, R> {
  readonly client: SuperLineClient<C, R>   // swaps guest↔authed under the hood
  readonly state: AuthState                // { status: 'guest' | 'authed'; userId; displayName; roles }
  readonly ready: Promise<void>            // await before reading state on load (confirms a persisted token via whoami)
  subscribe(cb: (s: AuthState) => void): () => void
  signUp(i: { email; password; displayName }): Promise<void>
  signIn(i: { email; password }): Promise<void>
  signOut(): Promise<void>
}

// /react
createAuth<C, R>(opts: AuthClientOptions<C, R>): { AuthProvider, useAuth, auth }
//   useAuth() → { client, state, ready: boolean, signUp, signIn, signOut }
```

Shared requests (every role): `signOut` / `whoami` / `createApiKey` / `listApiKeys` / `revokeApiKey` / `getToken`. Guest-only: `signIn` / `signUp` / `requestPasswordReset` / `confirmPasswordReset`.

Notes:
- **The factory is `auth()`**, not `createAuthKit`. Pass the **same `CollectionStore`** to `auth({ collections })` and `createSuperLineServer({ collections })` — `authenticate` reads sessions/users/apiKeys directly off it.
- **Login is a reconnect, not an upgrade.** A connection's role is frozen at connect, so `signIn`/`signUp` tear down the guest socket and reconnect as `authedRole` with `params: { token }`. Token persisted at `superline.auth.token`; `authClient` hides the guest↔authed swap.
- **Handshake precedence in `authenticate`:** `role === 'guest'` → guest; else `params.apiKey` (`slp_…`, one fixed role, stateful + revocable); else `params.jwt` (only if `jwt.secret` set — stateless, unrevocable pre-expiry); else `params.token` (session). Token/JWT paths throw `BAD_REQUEST` if no role requested, `FORBIDDEN` if the role isn't granted.
- `getToken()` throws `BAD_REQUEST` unless the server enabled `jwt`. `createApiKey` returns the raw `slp_…` value **once** and requires you already hold the requested role. `revoke(userId)` deletes sessions + disconnects cluster-wide but does NOT revoke API keys (do those per-key). `requestPasswordReset` is a silent no-op without `sendPasswordReset` and always returns `{ ok: true }` (never leaks email existence); `confirmPasswordReset` flushes all the user's sessions.
- **Imperative server management** (on `AuthServer`, for provisioning users + agents from server code — all require the running server): `authKit.users.get/find/create/update/setRoles/deactivate/reactivate/setPassword` and `authKit.apiKeys.create/listFor/revoke`. `users.create({ email, password?, displayName, roles?, metadata? })` — omit `password` for the **invite flow** (unclaimed until a password reset). Users **soft-delete**: `deactivate(id)` stamps `deletedAt` (the `users` row gains optional `deletedAt` + `metadata`), flushes sessions/keys/reset-tokens, kicks live connections, and blocks all three auth paths; `reactivate(id)` restores. `apiKeys.create(userId, { role, label, expiresInMs? })` mints an agent's key server-side (raw `slp_…` returned once). This is how you provision an **AI-agent user** for `@super-line/plugin-chat`.

## @super-line/plugin-chat

A reusable **chat backbone** as a paired plugin — channels (public/private), owner/member membership control, and messages (send/edit/delete) as typed collections. Subpaths: `.` (contract) · `/server` · `/client` · `/react` · `/ai` (AI SDK agent toolset). **Requires `@super-line/plugin-auth`** (identity + the `users` directory the FKs reference). Design: every mutation is a server-authoritative, hookable **request**; collections are client-read-only (ADR-0010).

```ts
// . (contract half) — generic over the message body (default z.string())
chatContract<S>(opts?: { content?: S }): ContractPlugin   // adds channels/memberships/messages + 16 shared requests
// plugins: [authContract(), chatContract()]  OR  chatContract({ content: myZodSchema })
// schemas/types: channelSchema/membershipSchema/messageSchema, ChatChannel/ChatMembership/ChatMessage, memId(channelId,userId)

// /server — factory is `chat`; bind to `chatKit`
chat<C>(opts: { contract: C; hooks?: ChatHooks; streaming?: { checkpointMs?; maxParts?; maxPartBytes?; maxEventsPerAppend?; project?(parts)→content } }): ChatServer
// hooks wrap DOMAIN cores → fire for client requests AND imperative chatKit calls, with an initiator { kind:'client',userId } | { kind:'server' }
//   ChatOpHook<In,Out> = { before?(input,initiator)→In|void (transform or throw-to-veto); after?(result,initiator) (throw propagates, write stays) }
//   hook keys: createChannel/updateChannel/deleteChannel/joinChannel/leaveChannel/addMember/removeMember/setMemberRole/sendMessage/editMessage/deleteMessage
//              + startMessage/finalizeMessage (STREAMING gates intent/audit only — appends are hook-free; forced aborts skip `before`, `after` always fires)
interface ChatServer {
  plugin: SuperLinePlugin            // read-RLS/write-deny policies + the 16 request handlers
  channels: { create({name,visibility?,owner?,metadata?}) / get / find({filter?,limit?,offset?}) / update / delete(cascades) }
  members:  { add(channelId,userId,{role?}) / remove / setRole / of(channelId) / channelsOf(userId) }
  messages: { send({channelId,authorId,content,metadata?}) / edit / delete / find({filter?,orderBy?,limit?,offset?})
              / stream({channelId,authorId})→ChatStreamWriter{push,finalize,abort} / abort(id,error?) (kill-switch)
              / partsOf(messageId) / sweepStale({olderThanMs}) (crashed-node repair — host-invoked, never automatic) }
}

// /client — NO TanStack/React dependency; owns the membership-driven re-subscribe mechanic. Agents use this too.
chatClient<C,R>(client, opts?: { userId?: string|null; messageLimit?: number; partsLimit?: number }): ChatClient<C>
//   request methods: createChannel/updateChannel/deleteChannel/join/leave/addMember/removeMember/setMemberRole/send/editMessage/deleteMessage
//   live stores: channels() / members(channelId) / messages(channelId,{limit?,partsLimit?,streaming?})  → each { rows(), subscribe(cb), ready, close() }
//   STREAMING (ADR-0011): messages() serves ONE ASSEMBLED feed — a streamed message gains `status` ('streaming'|'complete'|'aborted'|'error')
//   and live tree-ordered `parts` (text/reasoning/tool; subagent lanes nest via `parent`); plain messages untouched. Producer:
//   stream(channelId)→ChatStreamHandle{ push(...events) (sync, micro-batched), flush(), finalize(), abort() } — settle in a `finally`.
//   Events: part_start{key,partType,toolName?,parent?} · delta{key,text} · part_patch{key,args?,result?,isError?,state?} · part_end{key,text?}
//   (tool part key === toolCallId). Old turns whose parts left the partsLimit recency window render via `content` (parts absent).

// /react
createChatHooks<C>(): { ChatProvider, useChat, useChannels, useMembers, useMessages }
//   <ChatProvider chat={chatClient(client,{userId})}>…</ChatProvider>

// /ai — Vercel AI SDK toolset for an LLM bot; `ai` is an OPTIONAL peer dep. Takes the RAW SuperLineClient (needs `users` for author names).
chatAgentTools<C,R,S>(client, opts?: { content?: S; management?: boolean }): ToolSet   // spread into ToolLoopAgent({tools}) / generateText({tools})
//   CLIENT-SIDE by design: every tool rides the bot's own connection, so the server re-authorizes it (RLS reads, membership sends, owner management) — the model can't exceed the bot's permissions. STATELESS (one-shot subscribe→rows→close reads, typed-request writes; nothing to close). snake_case names; content host-parametrized (opts.content, default z.string()); failures return structured { error: code, message } so the model adapts instead of aborting.
//   core (default): list_channels(+member flag) · list_members · read_messages · send_message · join_channel · leave_channel
//   { management: true } adds: create_channel/update_channel/delete_channel · add_member/remove_member/set_member_role · edit_message/delete_message · list_users
pipeUIMessageStream(writer, stream): Promise<{ error?: string }>   // AI SDK v6 bridge: streamText(...).toUIMessageStream() / agent.stream(...) → a streamed chat message
//   maps text/reasoning/tool chunks onto parts (tool-input-delta + step framing + files/sources dropped); NEVER settles — finalize/abort stay yours; a turn-level error chunk is RETURNED, not thrown

// /mastra — plain Mastra Agents → streamed messages (the harness hookup, chat-scoped); `@mastra/core` OPTIONAL peer dep.
mastraEngine({ agent, subagents?: [{agent, delegatesTo?, maxSteps?}], delegatesTo?, maxSteps?, maxDepth? (3), suppressTools? }): MastraEngine
//   Agents stay VANILLA — the engine injects the `delegate` tool per stream call via toolsets ({agentType,task}→{content,isError}),
//   owns edges/depth gates (violations = isError tool results), lane keys (root s:, worker w:{toolCallId}: nested via `parent` under
//   the delegate part — which is ALWAYS emitted: it is the nesting anchor; never suppress it), and the harness-ported chunk mapping.
//   run(sink, input: string|ChatTurnMessage[], { abortSignal?, requestContext? }): Promise<{ text, error? }>  — never settles; root error RETURNED,
//     subagent failure = the delegate's isError result (turn continues). Abort = ONE turn signal at every depth, also fired by a dead sink
//     (flush checked at each step-finish: kill-switch/cap/disconnect ⇒ ~1 LLM step of waste, not a whole tree).
//   respond(chat, channelId, input, opts?): Promise<MessageRowOf|undefined>  — open→run→settle: error-finalize on turn error, DELETES
//     never-pushed empty turns (returns undefined), abort+rethrow on throw.
pipeMastraStream(sink, fullStream, { lane?, suppressTools? }): Promise<{ text, error? }>   // single-lane escape hatch, sibling of pipeUIMessageStream
//   Reasoning tokens stream as `reasoning` parts automatically ONCE THE MODEL EMITS THEM — enable thinking on the user's Agent, not the engine:
//   `defaultOptions: { providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: N≥1024 } } } }` (Mastra deep-merges it under
//   the engine's per-lane options, so it applies at every delegation depth). AI-SDK path: same providerOptions on ToolLoopAgent/streamText
//   (toUIMessageStream sends reasoning by default). With tools, Anthropic thinks at the START of each turn (interleaved thinking = separate beta).

// bot runtime (framework-agnostic — pairs with mastraEngine OR any AI-SDK producer)
provisionChatBot(authKit, chatKit, { name, email?, role? ('user'), keyLabel?, metadata?, channels? }): Promise<{ user, apiKey }>   // /server
//   restart-idempotent: find by DISPLAY NAME (public users row has no email), reactivate if soft-deleted, REVOKE+re-mint same-label key, idempotent joins
onChatMessage(chat, handler: ({channelId, message, history}) => …, { channels? ('all'|string[]), historyLimit? (8) }): () => void   // /client
//   'all' = RLS-visible channels (public + member-private), auto-join public on appear; backlog/own messages skipped; other producers'
//   streaming envelopes DEFER until settled; history = model-ready ChatTurnMessage[] w/ honest `[status — no text]` placeholders;
//   turns SERIALIZED per channel (queued msg's history sees the finished answer), channels concurrent; failed join retries next directory tick.
//   chatClient also exposes `userId` (resolved own id, read after `ready`). onChatMessage SKIPS resource cards (they never trigger a turn).

// ── Channel resources (PLAN-chat-resources) — your CRDT documents, attached to channels ─────────────
// A resource = one CRDT document (a `collections: { n: { schema, crdt } }` collection YOU declare) + a
// registry row linking it to a channel. Access is membership-gated through the registry. Needs the
// server's `crdtCollections:` backend + the client's `crdtCollections: crdtCollectionsClient()`.

// . / server — register kinds on the chat() factory (ONE act = createResource + policies + cascade):
chat({ contract, resources: { kinds: { [kind]: ResourceKindDef } }, hooks?, streaming? }): ChatServer
interface ResourceKindDef { collection: string; lifecycle?: 'owned'|'linked' (owned); init: (ctx: ResourceInitCtx) => data|Promise<data> }
//   ResourceInitCtx = { channelId, kind, id, title, params, userId: string|null, ctx: unknown }  — throw SuperLineError('VALIDATION') on bad params
//   Registering a kind AUTO-contributes membership-gated read/write policies for its collection — do NOT also declare `policies` for that
//   collection (server boot-throws "policy … collides", G4). Kind names must not contain ':' (composite-pk segment). Boot-throws if the
//   collection is missing or not a `crdt` collection. owned: chat mints the id, one channel, deleted on detach/channel-delete. linked:
//   host-supplied id (createResource({id})), attachable to MANY channels, doc NEVER chat-deleted (it's your content).
interface ChatServer { …; resources: {          // added to the kit
  create({ channelId, kind, title?, id?, params? }): Promise<ChatResource>   // create-or-attach; server-initiated (createdBy:null, NO card)
  detach(channelId, kind, docId): Promise<ChatResource>                       // owned ⇒ also deletes the doc
  of(channelId): Promise<ChatResource[]>
  sweepPresence({ olderThanMs }): Promise<number>                             // reap stale presence rows (host-invoked, never automatic)
} }

// /client (chatClient) — resource methods + live stores:
resources(channelId): ChatLiveStore<ChatResource>                              // the channel's registry rows
resourcePresence(collection, docId): ChatLiveStore<ResourcePresence>           // who's-open rows for one doc
createResource(channelId, { kind, title?, id?, params? }): Promise<ChatResource>   // create-or-attach; client-initiated ⇒ drops a resource CARD
detachResource(channelId, kind, docId): Promise<ChatResource>
writeResource(channelId, kind, docId, ops: ResourceWriteOp[] (≤64)): Promise<{ snapshot }>
//   ResourceWriteOp = { path: string[] (object-KEYS only, ≥1), set } | { path: string[], delete: true }  — arrays are opaque leaves: set the
//   whole array at its key, never index into one (→ VALIDATION). Acked: applied server-side, JSON-projection validated (honest VALIDATION whose
//   zod message the model reads), returns the post-write snapshot. Best-effort (a concurrent delta between validate+apply is an accepted race);
//   .catch() fields never reject. Contrast srv.collection(n).open(id): trusted, unvalidated, off the membership model — use writeResource for an
//   agent that is a channel MEMBER, srv.collection for an in-process privileged actor.
announceResource(kind, docId, state: 'open'|'heartbeat'|'close'): Promise<void>    // coarse presence; the human edits the doc via client.collection(n).open(id)

// the human edits the doc through the NATIVE surface — chat wraps nothing here:
client.collection(n).open(id): DocHandle          // or react useDoc(n, id); id = the resource row's docId

// /react
createChatHooks<C>(): { …, useChannelResources, useResourcePresence }
useChannelResources(channelId): ChatResource[]                                  // live registry rows
useResourcePresence(row: { kind, collection, docId }): ResourcePresence[]       // announces open on mount, 20s heartbeat, close on unmount; recency-filtered rows

// /ai — chatAgentTools gains 5 resource tools (core set): list_resources · read_resource (16KB-capped snapshot) · create_resource ·
//   detach_resource · write_resource. Pass opts.resourceShapes: { [kind]: '{ shape note }' } → appended to read/write descriptions so the model
//   writes without a read-first round-trip.

// shapes: ChatResource = { id (`${channelId}:${kind}:${docId}`), channelId, kind, collection, docId, title, createdBy: string|null, createdAt }
//   ResourcePresence = { id (`${collection}:${docId}:${userId}`), docKey (`${collection}:${docId}`), collection, docId, userId, openedAt, heartbeatAt }
//   resource CARD = a content-less message with metadata.resource = { action: 'created'|'attached'|'detached', kind, docId, title }
//   presence liveness = heartbeatAt recency (PRESENCE_LIVE_MS 45s; useResourcePresence heartbeats every 20s)
```

Rules: **public** channels are self-service join/leave; **private** are add-by-owner and answer `NOT_FOUND` to a non-member's `joinChannel` (anti-probing). Creator is the first `owner`; owners manage membership + rename/delete. **Last-owner protection**: leave/remove/demote throws `CONFLICT` if it would leave members with zero owners. Messages **hard-delete**; edit stamps `editedAt`. Membership is required for EVERY send (server included) — add an agent to a channel before it posts. **AI agents = regular users**: provision via `authKit.users.create` (no password) + `authKit.apiKeys.create`, add to a channel, connect with `params: { apiKey }` and the same `chatClient`. Known v1 caveat: per-channel serialization is in-process, so under relay clustering requests on other nodes can still interleave (no cross-node CAS).

## Contract plugins (compile-time contract merge)

`defineContract({ plugins: [...] })` merges each plugin's fragment INTO the contract by plain intersection, so `RowOf` / `client.collection` / per-role `Requests` all infer from the single materialized contract with zero type-threading. Existing no-plugin callers are untouched (the overload is identity).

```ts
defineContract<const C extends Contract & { plugins: readonly ContractPlugin[] }>(c: C): ResolveContract<C>
defineContract<const C extends Contract>(c: C): C            // no-plugins overload = identity

// author a plugin — ALWAYS via the helper (a plain const widens `subscribe: true` → boolean, degrading a topic to a push event):
defineContractPlugin<const F>(name: string, fragment: F): ContractPlugin<F>
interface ContractFragment { shared?: Directional; roles?: Record<string, RoleBlock>; collections?: Record<string, CollectionDef> }
```

- **Merge is collision-throwing:** a duplicate collection name, or a duplicate direction key in a role/shared block, throws at construction (`rename or prefix`). The same key in **opposite** directions is not a collision.
- **Handler subtraction (`SubtractHandlers`):** a block a plugin **fully** owns collapses to `{}` and becomes **optional** in `implement` — the host needn't pass `shared: {}` / `guest: {}`. A **partially**-owned block still requires its remaining keys; double-implementing a plugin's key is a compile error + a runtime throw naming the key.
- **Contract half vs runtime half are separate objects.** `defineContract({ plugins })` merges the *types/surface* only; the plugin's runtime `SuperLinePlugin` (handlers, policies, taps) must still be listed in `createSuperLineServer({ plugins })`. A paired plugin ships both (e.g. `authContract()` + `authKit.plugin`).
- A runtime plugin may contribute `policies` (merged into the host's, deny-by-default); a policy for a collection **no fragment declared** throws at construction.

## Composition (`defineSurface` / `mergeSurfaces`)

Embed a library's surface into a host role under **one** connection / session / identity — namespacing is a key-prefix convention plus two collision-proof helpers.

```ts
defineSurface<const D extends Directional>(surface: D): D    // identity; preserves literal keys + subscribe:true
mergeSurfaces<A, B>(a: A, b: B): MergedSurface<A, B>         // merges per direction; a duplicate key is a COMPILE error naming the key + a runtime throw
// MergedSurface = { clientToServer: CtsOf<A> & CtsOf<B>; serverToClient: StcOf<A> & StcOf<B> }
```

- `mergeSurfaces` merges `clientToServer` / `serverToClient` only, and **rejects any other key** — a role's `data` schema is banned from the merge, so add it **beside** the merge: `user: { ...mergeSurfaces(lib, app), data: schema }`. The same key in opposite directions is allowed.
- Wrap surfaces in `defineSurface(...)` for the same literal-preservation reason as `defineContractPlugin`.

## Control Center inspector (plugin)

`inspector(opts?: { redact?: string[] }): SuperLinePlugin` from `@super-line/plugin-inspector` is the **only** way to enable the Control Center — pass it in `plugins: [inspector()]`. The server no longer takes an `inspector` option and the WS transport no longer takes an `inspector` field. It taps every event (safe-snapshot + field-redact), publishes cluster-wide on its plugin channel, and serves the `InspectorContract` (`getContract` / `getTopology` / `listConnections` / `getNode` / `getConn` / `listCollections` / `queryCollection` + an `events` topic) over a reserved connection class. Dev / trusted-network only.
