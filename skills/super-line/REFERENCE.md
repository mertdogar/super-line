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
  inspector?: boolean                          // gate msg.* telemetry; also pass inspector:true to webSocketServerTransport
  stores?: Record<string, ServerStore>         // configured Stores, keyed by name (match the client). See Stores below.
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
  store(name: string): ServerStoreHandle                             // configured Store (off-contract); throws NOT_FOUND if unconfigured. See Stores below.
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
  stores?: Record<string, ClientStore>         // client halves of the Store pairs, keyed to match the server
  onStoreError?: (error, info: { store: string; id: string }) => void   // a rejected store write (e.g. FORBIDDEN)
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
  store(name: string): ClientStoreHandle           // configured Store; throws NOT_FOUND if unconfigured. See Stores below.
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
webSocketServerTransport(opts?: { server?; path?; backpressure?; inspector?: boolean }): ServerTransport
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
Redis: Pub/Sub (two connections) + a presence store. All adapters are at-most-once. Run more than one server process? Every server needs an adapter (the SAME backend). They carry rooms, topics (including cluster-bus `server.publish`/`server.subscribe`), targeted `toConn`/`toUser` sends, server→client request replies, store-Change/`sdel` relay for `relay` stores, AND the cluster presence registry (redis/libp2p/rabbitmq/zeromq all ship a `PresenceStore`).

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
  useResource<T>(name: string, id: string): {       // open a Store Resource; closes on unmount
    data: T | undefined                              // undefined until catch-up
    deleted: boolean                                 // true once the server fans out a delete for this Resource
    set: (value: T) => void                          // replace
    update: (partial: Partial<T>) => void            // merge
    delete: (path: (string | number)[]) => void      // surgical key removal
  }
}
```
Create the client once (e.g. `useState(() => createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user' }))`, `webSocketClientTransport` from `@super-line/transport-websocket`), wrap with `<Provider client={client}>`, then use the hooks inside.

## Stores (6: store-memory · store-sync · store-sqlite · store-sync-libsql · store-pglite · store-sync-pglite)

A Store is super-line's **off-contract** persisted-state seam: named, permissioned JSON Resources `{ id, accessRules, data }`. Configure a server + client pair under matching `stores:` keys. `data` is `unknown` end-to-end (not schema-validated). ACL is **deny-by-default**, keyed by the principal (`identify(conn) ?? conn.id`).

Each `ServerStore` declares two static traits the inspector surfaces: `model: 'lww' | 'crdt'` (replace vs merge) and `clustering: 'relay' | 'self'`. **`relay`** = the store does no networking; core relays its Changes/deletes across nodes over the server↔server Adapter (so >1 node needs an adapter). **`self`** = the store owns a shared backend + a per-node replica and fans only to LOCAL subscribers — it needs **NO adapter** (it IS the fan-out). Match model on both halves: LWW server ↔ `memoryStoreClient`, CRDT server ↔ `syncStoreClient`.

| package | model | durability | clustering | client half |
|---|---|---|---|---|
| store-memory | lww | in-memory | relay | `memoryStoreClient` |
| store-sync | crdt (Yjs) | in-memory | relay | `syncStoreClient` |
| store-sqlite | lww | better-sqlite3 (WAL) | relay | `memoryStoreClient` |
| store-sync-libsql | crdt (Yjs) | libsql / Turso / sqld | relay | `syncStoreClient` |
| store-pglite | lww | Postgres + Electric→PGlite | **self** | `memoryStoreClient` |
| store-sync-pglite | crdt (Yjs op-log) | Postgres + Electric→PGlite | **self** | `syncStoreClient` |

```ts
// each store package ships a server (and, for relay LWW/CRDT, a client) half:
memoryStoreServer(): ServerStore                                   // LWW, in-memory (default)
memoryStoreClient(opts?: { origin?: string }): ClientStore
syncStoreServer(opts?: { resolveOptions?: (id) => { mode?: 'shallow' | 'document'; opaque?: string[] } }): ServerStore  // CRDT (Yjs)
syncStoreClient(opts?: { origin?; resolveOptions? }): ClientStore  // pass the SAME resolveOptions to BOTH halves (no config drift)
sqliteStoreServer(opts: { file: string; table?: string }): ServerStore  // durable LWW (better-sqlite3); pair with memoryStoreClient()

// durable CRDT — ASYNC factory (rehydrates every Resource before returning); pair with syncStoreClient()
await libsqlSyncStore(opts: { url: string; authToken?: string; table?: string; debounceMs?: number; resolveOptions? }): Promise<ServerStore>
//   url: file:x.db | :memory: | libsql:// (Turso) | http(s):// (sqld). snapshot-per-resource (debounced), history-preserving rehydrate.

// self-clustering — NO adapter; central Postgres + per-node Electric→PGlite replica. ASYNC factories.
await pgliteStoreServer(opts: { pgUrl: string; electricUrl?: string; table?: string; db?: PGliteWithLive }): Promise<ServerStore>   // LWW; pair with memoryStoreClient()
await syncPgliteStoreServer(opts: { pgUrl; electricUrl?; table?; db?; resolveOptions?; compact?: false | { everyNUpdates?; debounceMs? }; onError? }): Promise<ServerStore>  // CRDT op-log; open()→ServerReplica; pair with syncStoreClient()

// SERVER — srv.store(name): server-authoritative; create/grant/revoke/delete have NO client wire
interface ServerStoreHandle {
  create(id, data, accessRules: Record<Principal, { read: boolean; write: boolean }>): Promise<void>
  read(id): Promise<Resource | undefined>            // admin read, bypasses ACL
  write(id, data): Promise<void>                      // one-shot co-write; LWW replace / CRDT MERGE; origin 'server'
  grant(id, principal, { read, write }): Promise<void>
  revoke(id, principal): Promise<void>
  delete(id): Promise<void>                           // remove the WHOLE Resource
  list(): Promise<string[]>
  open(id, opts?: { origin?: string }): ServerReplica // reactive in-process co-writer ↓
}
// reactive co-writer over canonical state — server-authoritative, no transport, no ACL:
interface ServerReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void               // fires on every applied change, incl. client edits (the reactive read side)
  set(data): void                                     // replace
  update(partial): void                               // MERGE top-level keys
  delete(path: (string | number)[]): void             // remove a key — the ONLY server-side key removal; atomic in-process
  close(): void
}

// CLIENT — client.store(name):
interface ClientStoreHandle {
  open(id): ResourceHandle                            // reactive: catch-up snapshot + live changes + write-through
  read(id): Promise<unknown>                          // one-shot
  write(id, data): Promise<void>                      // one-shot
}
interface ResourceHandle {
  getSnapshot(): unknown                              // undefined until `ready`
  subscribe(cb: () => void): () => void
  set(data): void                                     // optimistic + fire-and-forget (rejection → onStoreError, no rollback)
  update(partial): void
  delete(path: (string | number)[]): void            // surgical key removal (merges on CRDT, unlike a full-doc set)
  readonly ready: Promise<void>                       // resolves after catch-up; rejects FORBIDDEN/NOT_FOUND
  readonly deleted: boolean                           // true once the server fans out a delete for this id (a subscribe fires; re-read this + snapshot)
  close(): void                                       // drops the server subscription when the last handle for this id closes
}
// ServerStore (core) declares: readonly clustering: 'relay' | 'self'; readonly model?: 'lww' | 'crdt';
//   read/create/apply/setAccess/delete/list/onChange + optional onDelete?(cb: (id) => void) and open?(id, { origin? }).
//   onDelete is the delete-side mirror of onChange — `self` stores fire it from their backend's delete feed; core fans
//   each id to LOCAL subscribers. `relay` stores omit onDelete (core fans their deletes over the adapter from srv.store(n).delete).
// Deletion fan-out: srv.store(ns).delete(id) propagates cluster-wide as the wire SDeleteFrame ('sdel': { t:'sdel', n: store, id, nd?: origin node });
//   subscribed clients flip ResourceHandle.deleted / useResource().deleted true and fire their subscribe.
// core types: Resource<T> { id, accessRules: AccessRules, data: T }; AccessRules = Record<Principal, Perms>;
//   Perms { read, write }; Principal = string; StoreChange { id, update, origin }; ServerStore / ClientStore / ServerReplica / ResourceReplica.
//   removeAtPath(root, path: (string|number)[]): unknown — structural-clone delete helper, exported from core; used by both halves.
```

Notes:
- **Off-contract + unknown.** `data` is never schema-validated (a CRDT delta can't be); pass a type to `open<T>` / `useResource<T>` and assert it. Route hard typed gates through a request (ADR-0003).
- **Deny-by-default.** `grant` a principal before it can read/write. Server-side ops (`create`/`grant`/`open`/`write`) are server-authoritative and bypass ACL.
- **Merge vs delete.** `update`/`write` MERGE and can't remove a key; `delete(path)` is the only key removal. On the CRDT store it's surgical — a concurrent edit to another key survives; a full-document `set` would clobber it.
- **In-process co-writer.** `srv.store(ns).open(id)` is the right tool for a server-side AI agent / bot: reactive reads + delete, no loopback client and no grant. `origin` (default `'server'`) tags writes for echo-break + Control Center.
- **Clustering.** `relay` stores (memory, sync, sqlite, sync-libsql) are node-local — super-line relays their Changes across nodes over the **Adapter** (so >1 node needs one). `self` stores (pglite, sync-pglite) own a central Postgres + per-node Electric→PGlite replica and fan only to local subscribers — they need **NO adapter**. For LWW, cross-node writes resolve last-writer-wins; CRDT stores merge.
- **Deletion fan-out.** `srv.store(ns).delete(id)` removes the whole Resource and propagates cluster-wide as an `sdel` frame: subscribers see `ResourceHandle.deleted` / `useResource().deleted` go `true` (a `subscribe` fires). Without it a deleted Resource just reads as a silent empty snapshot. Distinct from `delete(path)`, which is a surgical key removal within a Resource.
- React: `useResource<T>(name, id)` wraps open + subscribe + write-through + unmount-close, and exposes `deleted` (see above).
