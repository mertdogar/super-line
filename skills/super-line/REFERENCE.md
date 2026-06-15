# super-line — API reference

Exact public surface. Signatures verified against source. `C` is the contract type, `R` a role (`keyof C['roles']`). `ctx` is whatever `authenticate` returns for that role.

## @super-line/core

```ts
defineContract(<const C>): C                 // identity; preserves literal keys + `subscribe: true`
// contract shape:
{
  shared?: {
    clientToServer?: Record<string, { input: Schema; output: Schema }>   // requests
    serverToClient?: Record<string, { payload: Schema; subscribe?: boolean }> // event | topic
  }
  roles: Record<string, {                    // at least one role
    clientToServer?: Record<string, { input: Schema; output: Schema }>
    serverToClient?: Record<string, { payload: Schema; subscribe?: boolean }>
  }>
  serverToServer?: Record<string, Schema>    // node <-> node payloads (not role-scoped)
}
// A role's effective surface = shared ∪ roles[R].
// serverToClient entry: { payload } => push event; { payload, subscribe: true } => client-subscribable topic.
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
}

// contract type: Contract, Directional, RequestDef, ServerMessageDef, Schema
// surface helpers: RoleOf<C>, Requests<C,R>, ServerMessages<C,R>, Events<C,R>, Topics<C,R>,
//   SharedRequests<C>, RoleRequests<C,R>, SharedEvents<C>, SharedTopics<C>, RoleTopics<C,R>, ServerEvents<C>
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
  onConnection?: (conn, ctx) => void
  onDisconnect?: (conn, ctx, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo) => void
}

interface SocketServer<C, A> {
  implement(handlers: Handlers<C, A>): SocketServer<C, A>             // chainable
  room(name: string): Room<C>                                        // mixed-role group
  publish<T extends keyof SharedTopics<C>>(topic: T, data): void      // SHARED topics
  forRole<R>(role: R): { publish<T extends keyof RoleTopics<C,R>>(topic: T, data): void }  // role topics
  emitServer<E extends keyof ServerEvents<C>>(event: E, data): void   // -> OTHER nodes (excludes self)
  onServer<E extends keyof ServerEvents<C>>(event: E, cb: (data) => void): () => void      // returns unsubscribe
  close(): Promise<void>                                              // closes conns + adapter + ws
}

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

class Conn<Ev, Ctx, Role> {
  readonly role: Role                          // this connection's role (typed literal)
  readonly ctx: Ctx
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
createRedisAdapter(options?: { url?: string } | string): Adapter
// createRedisAdapter('redis://localhost:6379')  — pass to every server's `adapter`
```
Redis Pub/Sub (two connections). At-most-once. Run more than one server process? Every server needs an adapter pointing at the same Redis. Carries rooms, topics, AND serverToServer.

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
