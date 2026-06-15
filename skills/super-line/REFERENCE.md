# super-line — API reference

Exact public surface. Signatures verified against source. `Ctx` is whatever `authenticate` returns (`undefined` if omitted). `C` is the contract type.

## @super-line/core

```ts
defineContract(<const C>): C                 // identity; preserves literal keys for inference
// contract shape:
{
  messages?: Record<string, { input: Schema; output: Schema }>
  events?:   Record<string, Schema>
  topics?:   Record<string, Schema>
}
// Schema = any StandardSchemaV1 validator (Zod, Valibot, ArkType...). Zod in examples.

validate(schema, value): Promise<Output>      // async-capable; throws SocketError('VALIDATION')
validateSync(schema, value): Output           // sync; throws on async schemas

class SocketError<Data> extends Error { code: ErrorCode; data?: Data
  constructor(code, message?, data?) }
// SocketErrorCode: BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | TIMEOUT | VALIDATION | DISCONNECTED | INTERNAL
// ErrorCode = SocketErrorCode | (string & {})  -> custom codes allowed

jsonSerializer: Serializer                    // default
interface Serializer { encode(v): string|Uint8Array; decode(d: string|Uint8Array): unknown }

interface Adapter {                           // cross-node fan-out seam
  subscribe(channel): void|Promise<void>
  unsubscribe(channel): void|Promise<void>
  publish(channel, payload: string|Uint8Array): void|Promise<void>
  onMessage(cb: (channel, payload) => void): void
  close?(): void|Promise<void>
}

// type helpers: Contract, MessageDef, Schema, InferIn<S>, InferOut<S>
PROTOCOL // 'superline.v1' (WS subprotocol)
```

## @super-line/server

```ts
createSocketServer<C, Ctx = undefined>(contract: C, opts?: ServerOptions<Ctx>): SocketServer<C, Ctx>

interface ServerOptions<Ctx> {
  server?: http.Server                         // attach to your server (compose w/ Express/Fastify/Hono)
  serializer?: Serializer                       // default jsonSerializer; MUST match the client
  adapter?: Adapter                             // default: per-server in-memory; use redis for multi-node
  path?: string                                 // only handle upgrades for this pathname
  authenticate?: (req: IncomingMessage) => Ctx | Promise<Ctx>   // throw -> 401, no socket; return -> ctx
  authorizeSubscribe?: (topic, ctx, conn) => boolean | void | Promise<boolean | void> // false/throw -> deny
  use?: Middleware<Ctx>[]                       // run before req/subscribe handlers
  onConnection?: (conn, ctx) => void
  onDisconnect?: (conn, ctx, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo<Ctx>) => void
}

interface SocketServer<C, Ctx> {
  implement(handlers: MessageHandlers<C, Ctx>): SocketServer<C, Ctx>  // chainable
  room(name: string): Room<C, Ctx>
  publish<T extends keyof C['topics']>(topic: T, data): void          // SERVER-ONLY publish
  close(): Promise<void>                                              // closes conns + adapter + ws
}

// handler shape:
type Handler = (input: InferOut<inputSchema>, ctx: Ctx, conn: Conn<Ctx>)
             => InferOut<outputSchema> | Promise<...>

interface Room<C, Ctx> {
  add(conn): void                              // server-controlled membership (subscribes the channel)
  remove(conn): void
  broadcast<E extends keyof C['events']>(event: E, data): void  // delivers a contract EVENT to members
  readonly size: number                        // LOCAL member count on this node
}

type Middleware<Ctx> = (ctx: Ctx, info: MiddlewareInfo<Ctx>, next: () => Promise<void>) => void|Promise<void>
interface MiddlewareInfo<Ctx> { kind: 'request' | 'subscribe'; name: string; conn: Conn<Ctx> }
// call next() to proceed; throw to short-circuit (reject). Does NOT change ctx's type.

class Conn<Ctx> { ctx: Ctx; channels: Set<string>; ws: WebSocket  // underlying 'ws' socket
  send(frame): void          // internal frame (you rarely call this)
  emit(event: string, data): void   // push an event to THIS connection (node-local)
  close(): void
}
// conn.ws.terminate() abruptly drops the socket — handy in tests to simulate a network drop.

// also exported: MemoryBus, createInMemoryAdapter (share one MemoryBus across servers to simulate nodes)
createInMemoryAdapter(bus?: MemoryBus): Adapter
```

Notes:
- `room.size` is the count on the *current node* only (membership is node-local; fan-out crosses nodes via the adapter).
- A "room" and a "topic" are the same channel substrate; the difference is who subscribes the connection (server `add` vs client `subscribe`).

## @super-line/client

```ts
createClient<C>(contract: C, opts: ClientOptions): Client<C>

interface ClientOptions {
  url: string
  params?: Record<string, string>              // appended as query string (read in authenticate)
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

// Client<C> is a typed proxy:
type Client<C> = {
  [K in keyof C['messages']]: (input, opts?: CallOptions) => Promise<output>  // throws SocketError
} & {
  on<E extends keyof C['events']>(event: E, handler: (data) => void): () => void   // returns unsubscribe
  subscribe<T extends keyof C['topics']>(topic: T, handler: (data) => void): Subscription
  close(): void
  readonly connected: boolean
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
Redis Pub/Sub (two connections). At-most-once. Run more than one server process? Every server needs an adapter pointing at the same Redis.

## @super-line/react

```ts
createSocketReact<C>(): {
  Provider: ({ client: Client<C>; children }) => ReactNode
  useClient(): Client<C>
  useEvent<E extends keyof C['events']>(event: E, handler: (data) => void): void
  useSubscription<T extends keyof C['topics']>(topic: T): InferOut<topicSchema> | undefined  // latest value
  useRequest<M extends keyof C['messages']>(method: M): {
    data?; error?: unknown; isLoading: boolean
    call: (input) => Promise<output>
  }
}
```
Create the client once (e.g. `useState(() => createClient(...))`), wrap with `<Provider client={client}>`, then use the hooks inside.
