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
  serverToServer?: Record<string, Schema>    // node <-> node payloads (not role-scoped)
}
// ServerEntry (serverToClient): { payload } => push event; { payload, subscribe: true } => topic;
//                               { input, output } => server→client request (client answers via client.implement)
// A role's effective surface = shared ∪ roles[R].
// Schema = any StandardSchemaV1 validator (Zod, Valibot, ArkType…). Zod in examples.

validate(schema, value): Promise<Output>     // async-capable; throws SocketError('VALIDATION')
validateSync(schema, value): Output          // sync; throws on async schemas

class SocketError<Data> extends Error { code: ErrorCode; data?: Data
  constructor(code, message?, data?) }
// SocketErrorCode: BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | TIMEOUT | VALIDATION | DISCONNECTED | INTERNAL
// ErrorCode = SocketErrorCode | (string & {})  -> custom codes allowed

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
//   SharedRequests<C>, RoleRequests<C,R>, SharedEvents<C>, SharedTopics<C>, RoleTopics<C,R>, ServerEvents<C>,
//   ServerRequests<C,R>, SharedServerRequests<C>, DataOf<C,R>, AnyData<C>
// presence: PresenceStore, ConnDescriptor, NodeStat
// extractors (guarded): ClientInput<T>, ServerInput<T>, Output<T>, EventData<T>, EmitData<T>, ServerEmit<T>, ServerData<T>
// InferIn<S>, InferOut<S>
```

## @super-line/server

```ts
createSocketServer<C, A extends AuthResult<C>>(contract: C, opts: ServerOptions<C, A>): SocketServer<C, A>
// A is inferred from authenticate's return — the discriminated { role, ctx } union.

type AuthResult<C> = { [R in keyof C['roles']]: { role: R; ctx: unknown } }[keyof C['roles']]

interface ServerOptions<C, A> {
  server?: http.Server                       // attach to your server (compose w/ Express/Fastify/Hono)
  serializer?: Serializer                     // default jsonSerializer; MUST match the client
  adapter?: Adapter                           // default: per-server in-memory; use redis for multi-node
  path?: string                               // only handle upgrades for this pathname
  authenticate: (req: IncomingMessage) => A | Promise<A>   // REQUIRED. Return { role, ctx }; throw -> 401
  authorizeSubscribe?: (topic, ctx, conn) => boolean | void | Promise<boolean | void> // false/throw -> deny
  use?: Middleware<A>[]                        // run before request/subscribe handlers
  onConnection?: (conn, ctx) => void           // runs just BEFORE the presence snapshot (seed conn.data here)
  onDisconnect?: (conn, ctx, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo) => void
  identify?: (conn) => string | undefined      // stable user key -> cluster.byUser / isOnline / toUser
  describeConn?: (conn) => Record<string, unknown>  // extra fields merged into the cluster descriptor (ctx never auto-serialized)
  heartbeat?: { interval?: number; maxMissed?: number } | false  // default { interval: 30_000 }; maxMissed -> reap
  backpressure?: { maxBufferedBytes: number; onExceed?: 'close' | 'drop' }  // guard slow consumers ('close' -> 1013)
}

interface SocketServer<C, A> {
  readonly nodeId: string                                            // this process's stable id
  implement(handlers: Handlers<C, A>): SocketServer<C, A>             // chainable
  room(name: string): Room<C>                                        // mixed-role group
  publish<T extends keyof SharedTopics<C>>(topic: T, data): void      // SHARED topics
  forRole<R>(role: R): { publish<T extends keyof RoleTopics<C,R>>(topic: T, data): void }  // role topics
  emitServer<E extends keyof ServerEvents<C>>(event: E, data): void   // -> OTHER nodes (excludes self)
  onServer<E extends keyof ServerEvents<C>>(event: E, cb: (data) => void): () => void      // returns unsubscribe
  // introspection
  readonly local: LocalView                                          // sync, THIS node
  readonly cluster: ClusterView                                      // async, registry-backed (needs presence adapter)
  isOnline(userId: string): Promise<boolean>                          // any live conn for this user key?
  // targeted cross-node send (no registry lookup on the delivery path)
  toConn(id: string): ConnTarget<C>                                  // one connection, any node
  toUser(userId: string): UserTarget<C>                              // all of a user's connections, any node
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
  readonly ws: WebSocket                       // underlying 'ws' socket
  send(frame): void                            // internal frame (you rarely call this)
  sendRaw(payload): void
  emit<E extends keyof Ev>(event: E, data): void   // push an event to THIS conn (node-local, role-scoped)
  close(): void
}
// conn.ws.terminate() abruptly drops the socket — handy in tests to simulate a network drop.

// also exported: MemoryBus, createInMemoryAdapter (share one MemoryBus across servers to simulate nodes)
createInMemoryAdapter(bus?: MemoryBus): Adapter
```

Notes:
- Dispatch resolves a handler by `conn.role`, which inherently enforces the boundary: a request not on `shared ∪ roles[conn.role]` returns **`NOT_FOUND`** (does not reveal other roles' surface).
- `room.size` is the count on the *current node* only. A "room" and a "topic" share the same channel substrate; the difference is who subscribes (server `add` vs client `subscribe`).
- Role topics are namespaced per role on the wire; the client subscribes by the plain topic name.
- `emitServer` stamps a per-server instance id and drops its own messages on receive (exclude-self); single-node = no-op.

## @super-line/client

```ts
createClient<C, R extends keyof C['roles']>(contract: C, opts: ClientOptions<C, R>): Client<C, R>

interface ClientOptions<C, R> {
  url: string
  role: R                                      // REQUIRED: narrows the surface AND is sent to the server to verify
  params?: Record<string, string>             // appended as query string (read in authenticate); `role` is added automatically
  serializer?: Serializer                       // MUST match the server
  timeoutMs?: number                            // default 30000
  validate?: 'off' | 'inbound'                  // default 'off'; 'inbound' re-validates server->client (catch drift)
  onValidationError?: (error, info: { kind: 'response'|'event'|'topic'; name }) => void
  reconnect?: boolean                           // default true
  reconnectBaseMs?: number                      // default 500
  reconnectMaxMs?: number                       // default 30000
  reconnectFactor?: number                      // default 2
  WebSocket?: typeof WebSocket                  // default globalThis.WebSocket (browsers, Node 22+)
}

// Client<C, R> is a typed proxy narrowed to role R's effective surface (shared ∪ R):
type Client<C, R> = {
  [K in keyof Requests<C, R>]: (input, opts?: CallOptions) => Promise<output>  // throws SocketError
} & {
  on<E extends keyof Events<C, R>>(event: E, handler: (data) => void): () => void   // returns unsubscribe
  subscribe<T extends keyof Topics<C, R>>(topic: T, handler: (data) => void): Subscription
  implement(handlers: { [K in keyof ServerRequests<C, R>]?: (input) => Awaitable<output> }): void  // answer server→client requests; throw SocketError for typed failure
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

## @super-line/adapter-redis

```ts
createRedisAdapter(options?: { url?: string; presenceTtlMs?: number } | string): Adapter
// createRedisAdapter('redis://localhost:6379')  — pass to every server's `adapter`
// presenceTtlMs (default 90_000): node liveness key TTL, refreshed by the heartbeat; must exceed heartbeat interval
```
Redis Pub/Sub (two connections) + a presence store. At-most-once. Run more than one server process? Every server needs an adapter pointing at the same Redis. Carries rooms, topics, serverToServer, targeted `toConn`/`toUser` sends, server→client request replies, AND the cluster presence registry.

## @super-line/react

```ts
createSocketReact<C, R extends keyof C['roles']>(): {
  Provider: ({ client: Client<C, R>; children }) => ReactNode
  useClient(): Client<C, R>
  useEvent<E extends keyof Events<C, R>>(event: E, handler: (data) => void): void
  useSubscription<T extends keyof Topics<C, R>>(topic: T): data | undefined  // latest value
  useRequest<M extends keyof Requests<C, R>>(method: M): {
    data?; error?: unknown; isLoading: boolean
    call: (input) => Promise<output>
  }
}
```
Create the client once (e.g. `useState(() => createClient(api, { url, role: 'user' }))`), wrap with `<Provider client={client}>`, then use the hooks inside.
