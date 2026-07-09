import {
  jsonSerializer,
  validateSync,
  SuperLineError,
  matchesFilter,
  applyQuery,
  isCrdtCollection,
  type Schema,
  type Serializer,
  type Contract,
  type ServerFrame,
  type RoleOf,
  type Requests,
  type Events,
  type Topics,
  type RequestDef,
  type ServerEntry,
  type ServerRequests,
  type ClientInput,
  type ServerInput,
  type Output,
  type EventData,
  type SReqFrame,
  type ClientTransport,
  type RawConn,
  type ResourceReplica,
  type StoreChange,
  type TapEvent,
  type CollectionQuery,
  type CChangeFrame,
  type CrdtCollectionClient,
  type RowOp,
  type CollectionName,
  type CrdtCollectionName,
  type RowOf,
  type DocOf,
} from '@super-line/core'
import { backoffDelay } from './backoff.js'

export { backoffDelay } from './backoff.js'
export type { BackoffOptions } from './backoff.js'

/** Per-call options for a request. */
export interface CallOptions {
  /** Override the default request timeout (ms). `0` disables the timeout. */
  timeoutMs?: number
  /** Abort the request; rejects with a `BAD_REQUEST` `SuperLineError`. */
  signal?: AbortSignal
}

/** A topic subscription handle returned by `client.subscribe`. */
export interface Subscription {
  /** Resolves when the server acknowledges the subscribe; rejects if denied or disconnected. */
  readonly ready: Promise<void>
  /** Stop receiving the topic and tell the server to unsubscribe. */
  unsubscribe(): void
}

type Awaitable<T> = T | Promise<T>

/** Handlers answering server→client requests for the role's surface (`shared` ∪ role). */
export type ServerHandlers<C extends Contract, R extends RoleOf<C>> = {
  [K in keyof ServerRequests<C, R>]?: (
    input: ServerInput<ServerRequests<C, R>[K]>,
  ) => Awaitable<Output<ServerRequests<C, R>[K]>>
}

/** The request-calling half of {@link SuperLineClient} (one method per request in the role's surface). */
export type ClientMethods<C extends Contract, R extends RoleOf<C>> = {
  [K in keyof Requests<C, R>]: (
    input: ClientInput<Requests<C, R>[K]>,
    opts?: CallOptions,
  ) => Promise<Output<Requests<C, R>[K]>>
}

/**
 * A typed client proxy, narrowed to role `R`'s effective surface (`shared` ∪ `R`).
 * Call requests as methods; listen with `on`; subscribe to topics with `subscribe`.
 */
export type SuperLineClient<C extends Contract, R extends RoleOf<C>> = ClientMethods<C, R> & {
  /** Listen for a server-pushed event. Returns an unsubscribe function. */
  on<E extends keyof Events<C, R>>(
    event: E,
    handler: (data: EventData<Events<C, R>[E]>) => void,
  ): () => void
  /** Subscribe to a topic (auto re-subscribes on reconnect). Await `.ready` to confirm. */
  subscribe<T extends keyof Topics<C, R>>(
    topic: T,
    handler: (data: EventData<Topics<C, R>[T]>) => void,
  ): Subscription
  /** Register handlers answering server→client requests. Throw a `SuperLineError` for a typed failure. */
  implement(handlers: ServerHandlers<C, R>): void
  /**
   * Client-side handle for a contract collection, typed by the contract: an LWW row collection gives a
   * `CollectionHandle` (`subscribe`/`insert`/`batch`), a CRDT document collection gives a
   * `CrdtCollectionHandle` (`open(id)` → reactive doc).
   */
  collection<N extends CollectionName<C>>(
    name: N,
  ): N extends CrdtCollectionName<C> ? CrdtCollectionHandle<DocOf<C, N>> : CollectionHandle<RowOf<C, N>>
  /** Close the connection and stop reconnecting. */
  close(): void
  /** Whether the socket is currently open. */
  readonly connected: boolean
  /** This client's role. */
  readonly role: R
}

/** A fine-grained change to a {@link LiveRowSet} (fed to sync consumers like the TanStack DB adapter). */
export interface RowSetEvent<Row = unknown> {
  type: 'insert' | 'update' | 'delete'
  id: string
  /** The row (present for insert/update; absent for delete). */
  row?: Row
}

/**
 * A live view of the rows matching one subscription — the raw, **non-optimistic** sync primitive beneath the
 * TanStack DB adapter. The initial snapshot arrives via `ready`; thereafter every matching change streams as a
 * {@link RowSetEvent}. Rows leaving the filter (an update that no longer matches) arrive as `delete` events.
 * Auto-resubscribes and re-diffs on reconnect. Optimism belongs to the layer above (TanStack), not here.
 */
export interface LiveRowSet<Row = unknown> {
  /** Current matching rows, ordered + limited per the subscription query (stable reference between changes). */
  rows(): Row[]
  /** Subscribe to per-row changes. A `() => void` consumer (e.g. useSyncExternalStore) may ignore the event. Returns an unsub. */
  subscribe(cb: (ev: RowSetEvent<Row>) => void): () => void
  /** Resolves once the initial snapshot has been applied. */
  readonly ready: Promise<void>
  /** Stop the subscription and tell the server to drop it. */
  close(): void
}

/** Client-side handle for one contract collection, reached via `client.collection(name)`. Typed by the contract. */
export interface CollectionHandle<Row = unknown> {
  /** Open a live subset subscription (omit the query for the whole collection, subject to server policy). */
  subscribe(query?: CollectionQuery): LiveRowSet<Row>
  /** Insert a row (its key field becomes the id). Resolves on the server ack; rejects on conflict/denial. */
  insert(row: Row): Promise<void>
  /** Replace a row by its key (LWW). */
  update(row: Row): Promise<void>
  /** Delete a row by id. */
  delete(id: string): Promise<void>
  /** Apply several ops as ONE atomic batch (all-or-nothing on the server). */
  batch(ops: Array<{ type: 'insert' | 'update'; row: Row } | { type: 'delete'; id: string }>): Promise<void>
}

/**
 * A reactive handle over one opened CRDT document (ADR-0007).
 * `set`/`update` mutate the local replica and write the resulting delta through to the server, which
 * validate-before-commits it; on rejection the server resyncs this replica.
 */
export interface DocHandle<Doc = unknown> {
  /** The current snapshot (`undefined` until the catch-up snapshot arrives). */
  getSnapshot(): Doc | undefined
  /** Subscribe to changes (local writes + remote merges). Returns an unsubscribe fn. */
  subscribe(cb: () => void): () => void
  /** Replace the document (mutates the local CRDT doc); the delta is sent to the server. */
  set(data: Doc): void
  /** Merge a partial update; the delta is sent to the server. */
  update(partial: Partial<Doc>): void
  /** Surgically remove the value at `path` (merges, unlike a full-doc `set`); sent to the server. */
  delete(path: (string | number)[]): void
  /** Resolves once the catch-up snapshot has been applied; rejects if the open is denied or the doc is absent. */
  readonly ready: Promise<void>
  /** True once the server fans out a delete for this document. */
  readonly deleted: boolean
  /** Stop receiving changes and tell the server to unsubscribe. */
  close(): void
}

/** Client-side handle for one CRDT document collection, reached via `client.collection(name)` (opened by id). */
export interface CrdtCollectionHandle<Doc = unknown> {
  /** Open a reactive handle for a document (catch-up snapshot + live merges + write-through). */
  open(id: string): DocHandle<Doc>
}

/** What went wrong, passed to the client `onError` sink alongside the caught error. */
export interface ClientErrorInfo {
  /** Which lifecycle hook threw. */
  kind: 'connect' | 'disconnect' | 'reconnect'
}

/**
 * The client half of a {@link https://…|SuperLinePlugin} pair, registered on `plugins: [...]`. All fields
 * optional. Mirrors the server half but smaller — no taps in v1 (`onEvent` is type-reserved) and no
 * handler subtraction (client `implement` is already optional per-key).
 */
export interface SuperLineClientPlugin {
  /** Unique among the client's plugins; a duplicate name throws at construction. */
  name: string
  /** Called on the first successful connect (multiplexed after the client's `onConnect`). */
  onConnect?: () => void
  /** Called when the socket drops, with the close `code` (multiplexed after `onDisconnect`). */
  onDisconnect?: (code: number) => void
  /** Called on each successful reconnect after the first (multiplexed after `onReconnect`). */
  onReconnect?: () => void
  /** Type-reserved for a client-side tap; NOT instrumented in v1. */
  onEvent?: (event: TapEvent) => void
  /** Handlers answering the library's server→client requests; a key collision (with the app or another plugin) throws. */
  implement?: Record<string, (input: unknown) => Awaitable<unknown>>
}

/** Describes which inbound payload failed validation, passed to `onValidationError`. */
export interface ValidationErrorInfo {
  /** The kind of inbound payload that failed. */
  kind: 'response' | 'event' | 'topic'
  /** The request/event/topic name. */
  name: string
}

/** Options for {@link createSuperLineClient}. */
export interface SuperLineClientOptions<C extends Contract, R extends RoleOf<C>> {
  /** The transport to dial on, e.g. `webSocketClientTransport({ url: 'ws://localhost:3000' })`. */
  transport: ClientTransport
  /** This client's role; narrows the surface and is sent to the server to verify. */
  role: R
  /** Extra handshake params passed to the transport (read in `authenticate`); `role` is added automatically. */
  params?: Record<string, string>
  /** Wire serializer; MUST match the server. Defaults to `jsonSerializer`. */
  serializer?: Serializer
  /** Default request timeout in ms. Defaults to `30000`. */
  timeoutMs?: number
  /** `'inbound'` re-validates server→client payloads against the contract (catches drift). Default `'off'`. */
  validate?: 'off' | 'inbound'
  /** Called when an inbound payload fails validation (only with `validate: 'inbound'`). */
  onValidationError?: (error: unknown, info: ValidationErrorInfo) => void
  /**
   * The client-side CRDT engine for CRDT document collections (ADR-0007), e.g.
   * `crdtCollections: crdtCollectionsClient()`. Universal across backend tiers — the client only merges
   * opaque deltas. Required to `open` any CRDT collection.
   */
  crdtCollections?: CrdtCollectionClient
  /** Called when a CRDT document write is rejected by the server (e.g. FORBIDDEN, validation). Default: logs to console. */
  onStoreError?: (error: unknown, info: { store: string; id: string }) => void
  /** Client plugin halves (lifecycle, server→client handlers). See {@link SuperLineClientPlugin}. */
  plugins?: SuperLineClientPlugin[]
  /** Called on the first successful connect. */
  onConnect?: () => void
  /** Called when the socket drops, with the close `code`. */
  onDisconnect?: (code: number) => void
  /** Called on each successful reconnect after the first. */
  onReconnect?: () => void
  /** Receives a throw from any lifecycle hook (host or plugin). Default: logs to console. */
  onError?: (error: unknown, info: ClientErrorInfo) => void
  /** Auto-reconnect on drop. Defaults to `true`. */
  reconnect?: boolean
  /** Initial reconnect backoff in ms. Defaults to `500`. */
  reconnectBaseMs?: number
  /** Maximum reconnect backoff in ms. Defaults to `30000`. */
  reconnectMaxMs?: number
  /** Backoff growth factor. Defaults to `2`. */
  reconnectFactor?: number
}

interface Request {
  method: string
  frame: string | Uint8Array
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  sent: boolean
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  void promise.catch(() => {}) // avoid unhandled rejection when callers don't await
  return { promise, resolve, reject }
}

/**
 * Create a typed client for role `R`. Connects immediately and reconnects on its own.
 *
 * @param contract - the shared contract.
 * @param opts - client options; `url` and `role` are required.
 * @returns a {@link SuperLineClient} proxy narrowed to the role's surface.
 *
 * @example
 * ```ts
 * const client = createSuperLineClient(api, {
 *   transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
 *   role: 'user',
 *   params: { token },
 * })
 * client.on('message', (m) => console.log(m.text))
 * const out = await client.send({ text: 'hi' }) // throws SuperLineError on failure
 * ```
 */
export function createSuperLineClient<C extends Contract, R extends RoleOf<C>>(
  contract: C,
  opts: SuperLineClientOptions<C, R>,
): SuperLineClient<C, R> {
  const c: Contract = contract
  const role = opts.role
  const serializer = opts.serializer ?? jsonSerializer
  const defaultTimeout = opts.timeoutMs ?? 30_000
  const validateInbound = (opts.validate ?? 'off') === 'inbound'
  const reconnectEnabled = opts.reconnect ?? true
  const backoff = {
    baseMs: opts.reconnectBaseMs ?? 500,
    maxMs: opts.reconnectMaxMs ?? 30_000,
    factor: opts.reconnectFactor ?? 2,
  }

  // role rides along in the handshake params so the server's authenticate can verify it
  const handshakeParams = { ...opts.params, role }
  const requests = new Map<number, Request>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const topicListeners = new Map<string, Set<(data: unknown) => void>>()
  const readyByTopic = new Map<string, Deferred>() // topics awaiting their first ack
  const subAckById = new Map<number, string>() // outstanding sub frame id -> topic
  const serverHandlers = new Map<string, (input: unknown) => unknown>() // answer server→client requests
  const crdtClient = opts.crdtCollections // client-side CRDT engine for CRDT document collections (ADR-0007)

  const clientPlugins = opts.plugins ?? []
  const pluginNames = new Set<string>()
  for (const p of clientPlugins) {
    if (pluginNames.has(p.name)) throw new Error(`Duplicate plugin name: ${p.name}`)
    pluginNames.add(p.name)
  }
  // register a server→client handler, throwing on a name collision (app implement, or another plugin)
  function registerServerHandler(name: string, handler: (input: unknown) => unknown): void {
    if (serverHandlers.has(name)) throw new Error(`Duplicate server→client handler for '${name}'`)
    serverHandlers.set(name, handler)
  }
  for (const p of clientPlugins) {
    if (p.implement) for (const [name, handler] of Object.entries(p.implement)) registerServerHandler(name, handler)
  }

  // lifecycle fan-out: host hook first, then plugins in order; a throw is isolated + routed to onError.
  let connectedOnce = false
  const connectHooks = [opts.onConnect, ...clientPlugins.map((p) => p.onConnect)]
  const disconnectHooks = [opts.onDisconnect, ...clientPlugins.map((p) => p.onDisconnect)]
  const reconnectHooks = [opts.onReconnect, ...clientPlugins.map((p) => p.onReconnect)]
  function routeError(error: unknown, kind: ClientErrorInfo['kind']): void {
    if (opts.onError) {
      try {
        opts.onError(error, { kind })
      } catch {
        // an onError that itself throws has nowhere left to go
      }
    } else console.error(`[super-line] client ${kind} handler threw`, error)
  }
  function fireLifecycle(hooks: Array<((code: number) => void) | undefined>, kind: ClientErrorInfo['kind'], code: number): void {
    for (const hook of hooks) {
      if (!hook) continue
      try {
        hook(code)
      } catch (err) {
        routeError(err, kind)
      }
    }
  }
  // opened CRDT documents (ADR-0007), keyed `n\0id`: routes inbound `cdchg` to local replicas, re-opens on reconnect
  interface OpenDocEntry {
    n: string
    id: string
    replicas: Set<ResourceReplica>
    ready: Deferred
    settled: boolean
    deleted: boolean
  }
  const openDocs = new Map<string, OpenDocEntry>()
  // live collection subscriptions: `cchg` frames route here by collection name; all re-subscribe (+ re-diff) on reconnect
  interface LiveSub {
    n: string
    subId: number
    query: CollectionQuery
    key: string // primary-key field, from the contract
    map: Map<string, unknown> // every filter-matching row seen (unbounded by limit; the view applies the window)
    view: unknown[] // ordered + limited derivation, recomputed on change (stable ref between changes)
    listeners: Set<(ev: RowSetEvent) => void>
    ready: Deferred
    settled: boolean
  }
  const collectionSubs = new Map<number, LiveSub>() // subId → sub (drives reconnect re-subscribe)
  const collectionSubsByName = new Map<string, Set<LiveSub>>() // collection → subs (drives `cchg` dispatch)
  let nextSubId = 1

  // resolve contract defs from this role's effective surface (shared ∪ role)
  function reqDef(method: string): RequestDef | undefined {
    return c.roles[role]?.clientToServer?.[method] ?? c.shared?.clientToServer?.[method]
  }
  function serverEntry(name: string): ServerEntry | undefined {
    return c.roles[role]?.serverToClient?.[name] ?? c.shared?.serverToClient?.[name]
  }
  function payloadOf(name: string): Schema | undefined {
    const def = serverEntry(name)
    return def && 'payload' in def ? def.payload : undefined
  }

  let rawConn: RawConn | undefined
  let nextId = 1
  let closed = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function connect(): void {
    rawConn = opts.transport.connect(handshakeParams, {
      onOpen,
      onMessage,
      onClose,
      onDrain: () => {},
    })
  }

  function onOpen(): void {
    attempt = 0
    for (const op of requests.values()) {
      if (!op.sent) {
        rawConn?.send(op.frame)
        op.sent = true
      }
    }
    for (const topic of topicListeners.keys()) sendSub(topic)
    for (const entry of openDocs.values()) sendDocOpen(entry) // re-open CRDT docs → fresh full Yjs state (client re-merges)
    for (const sub of collectionSubs.values()) sendCollectionSub(sub) // re-snapshot collection subscriptions (client re-diffs)
    if (connectedOnce) fireLifecycle(reconnectHooks, 'reconnect', 0)
    else {
      connectedOnce = true
      fireLifecycle(connectHooks, 'connect', 0)
    }
  }

  function onClose(code = 1006): void {
    fireLifecycle(disconnectHooks, 'disconnect', code)
    for (const [id, op] of requests) {
      if (op.sent) {
        if (op.timer) clearTimeout(op.timer)
        op.reject(new SuperLineError('DISCONNECTED', 'Connection closed'))
        requests.delete(id)
      }
    }
    subAckById.clear() // acks won't arrive; reconnect re-subscribes

    if (closed || !reconnectEnabled) {
      for (const [id, op] of requests) {
        if (op.timer) clearTimeout(op.timer)
        op.reject(new SuperLineError('DISCONNECTED', 'Connection closed'))
        requests.delete(id)
      }
      return
    }
    reconnectTimer = setTimeout(connect, backoffDelay(attempt++, backoff))
  }

  function onMessage(data: Uint8Array): void {
    let frame: ServerFrame
    try {
      frame = serializer.decode(data) as ServerFrame
    } catch {
      return
    }
    if (frame.t === 'ping') {
      rawConn?.send(serializer.encode({ t: 'pong' }))
      return
    }
    if (frame.t === 'res') {
      const topic = subAckById.get(frame.i)
      if (topic !== undefined) {
        subAckById.delete(frame.i)
        const r = readyByTopic.get(topic)
        if (r) {
          readyByTopic.delete(topic)
          r.resolve()
        }
        return
      }
      settleRequest(frame.i, (op) => {
        if (validateInbound) {
          const def = reqDef(op.method)
          if (def) {
            try {
              validateSync(def.output, frame.d)
            } catch (e) {
              op.reject(e)
              return
            }
          }
        }
        op.resolve(frame.d)
      })
    } else if (frame.t === 'err' && frame.i !== undefined) {
      const topic = subAckById.get(frame.i)
      if (topic !== undefined) {
        subAckById.delete(frame.i)
        const r = readyByTopic.get(topic)
        if (r) {
          readyByTopic.delete(topic)
          r.reject(new SuperLineError(frame.code, frame.m, frame.d))
        }
        topicListeners.delete(topic) // denied -> drop local listeners
        return
      }
      settleRequest(frame.i, (op) => op.reject(new SuperLineError(frame.code, frame.m, frame.d)))
    } else if (frame.t === 'evt') {
      if (!checkInbound(payloadOf(frame.e), frame.d, { kind: 'event', name: frame.e }))
        return
      const set = listeners.get(frame.e)
      if (set) for (const cb of set) cb(frame.d)
    } else if (frame.t === 'pub') {
      if (!checkInbound(payloadOf(frame.c), frame.d, { kind: 'topic', name: frame.c }))
        return
      const set = topicListeners.get(frame.c)
      if (set) for (const cb of set) cb(frame.d)
    } else if (frame.t === 'sreq') {
      void handleServerRequest(frame)
    } else if (frame.t === 'cchg') {
      const subs = collectionSubsByName.get(frame.n)
      if (subs) for (const sub of subs) applyCollectionChange(sub, frame) // client re-filters per subscription
    } else if (frame.t === 'cdchg') {
      const entry = openDocs.get(docKey(frame.n, frame.id))
      if (entry) {
        const change = { id: frame.id, update: frame.u, origin: frame.o }
        for (const replica of entry.replicas) replica.applyRemote(change) // own-origin merges are no-ops
      }
    } else if (frame.t === 'cddel') {
      const entry = openDocs.get(docKey(frame.n, frame.id))
      if (entry) {
        entry.deleted = true
        for (const replica of entry.replicas) replica.applyDelete()
      }
    }
  }

  async function handleServerRequest(frame: SReqFrame): Promise<void> {
    const send = (f: object) => {
      if (rawConn?.writable) rawConn.send(serializer.encode(f))
    }
    const handler = serverHandlers.get(frame.m)
    if (!handler) {
      send({ t: 'serr', i: frame.i, code: 'NOT_FOUND', m: `No handler for ${frame.m}` })
      return
    }
    let input = frame.d
    const def = serverEntry(frame.m)
    if (validateInbound && def && 'input' in def) {
      try {
        input = validateSync(def.input as Schema, frame.d)
      } catch {
        send({ t: 'serr', i: frame.i, code: 'VALIDATION', m: 'Validation failed' })
        return
      }
    }
    try {
      const output = await handler(input)
      send({ t: 'sres', i: frame.i, d: output })
    } catch (e) {
      const se = e instanceof SuperLineError ? e : new SuperLineError('INTERNAL', 'Internal client error')
      send({ t: 'serr', i: frame.i, code: se.code, m: se.message, d: se.data })
    }
  }

  function checkInbound(schema: Schema | undefined, data: unknown, info: ValidationErrorInfo): boolean {
    if (!validateInbound || !schema) return true
    try {
      validateSync(schema, data)
      return true
    } catch (e) {
      if (opts.onValidationError) opts.onValidationError(e, info)
      else console.error(`[super-line] inbound validation failed for ${info.kind} '${info.name}'`, e)
      return false
    }
  }

  function settleRequest(id: number, run: (op: Request) => void): void {
    const op = requests.get(id)
    if (!op) return
    requests.delete(id)
    if (op.timer) clearTimeout(op.timer)
    run(op)
  }

  function call(method: string, input: unknown, callOpts?: CallOptions): Promise<unknown> {
    if (closed) return Promise.reject(new SuperLineError('DISCONNECTED', 'Client closed'))
    const id = nextId++
    const frame = serializer.encode({ t: 'req', i: id, m: method, d: input })
    return new Promise<unknown>((resolve, reject) => {
      const ms = callOpts?.timeoutMs ?? defaultTimeout
      const timer =
        ms > 0
          ? setTimeout(() => {
              requests.delete(id)
              reject(new SuperLineError('TIMEOUT', `Request '${method}' timed out`))
            }, ms)
          : undefined
      const op: Request = { method, frame, resolve, reject, timer, sent: false }
      requests.set(id, op)
      callOpts?.signal?.addEventListener(
        'abort',
        () => {
          if (requests.delete(id)) {
            if (timer) clearTimeout(timer)
            reject(new SuperLineError('BAD_REQUEST', 'Aborted'))
          }
        },
        { once: true },
      )
      if (rawConn?.writable) {
        rawConn.send(frame)
        op.sent = true
      }
    })
  }

  function sendSub(topic: string): void {
    const id = nextId++
    subAckById.set(id, topic)
    rawConn?.send(serializer.encode({ t: 'sub', i: id, c: topic }))
  }

  function topicSet(topic: string): Set<(data: unknown) => void> {
    let set = topicListeners.get(topic)
    if (!set) {
      set = new Set()
      topicListeners.set(topic, set)
    }
    return set
  }

  function subscribe(topic: string, handler: (data: unknown) => void): Subscription {
    const isNew = !topicListeners.has(topic)
    topicSet(topic).add(handler)

    let ready: Promise<void>
    if (isNew) {
      const d = deferred()
      readyByTopic.set(topic, d)
      ready = d.promise
      if (rawConn?.writable) sendSub(topic) // else onOpen re-subscribes
    } else {
      ready = readyByTopic.get(topic)?.promise ?? Promise.resolve()
    }

    let active = true
    return {
      ready,
      unsubscribe: () => {
        if (!active) return
        active = false
        const set = topicListeners.get(topic)
        if (!set) return
        set.delete(handler)
        if (set.size === 0) {
          topicListeners.delete(topic)
          readyByTopic.delete(topic)
          if (rawConn?.writable) rawConn.send(serializer.encode({ t: 'unsub', c: topic }))
        }
      },
    }
  }

  // Request/response correlation reuses the `requests` map: an op gets a res/err carrying the same `i`, and
  // `reqDef` is undefined for these internal methods so inbound validation is skipped. One-shot ops ride the
  // generic unsent-resend on reconnect; CRDT doc opens are driven by `sendDocOpen` + the onOpen entry loop.
  function trackRequest(method: string, makeFrame: (id: number) => object): Promise<unknown> {
    if (closed) return Promise.reject(new SuperLineError('DISCONNECTED', 'Client closed'))
    const id = nextId++
    const frame = serializer.encode(makeFrame(id))
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        defaultTimeout > 0
          ? setTimeout(() => {
              requests.delete(id)
              reject(new SuperLineError('TIMEOUT', `${method} timed out`))
            }, defaultTimeout)
          : undefined
      const op: Request = { method, frame, resolve, reject, timer, sent: false }
      requests.set(id, op)
      if (rawConn?.writable) {
        rawConn.send(frame)
        op.sent = true
      }
    })
  }

  // ---- CRDT document collections (ADR-0007): open-by-id merging docs ----
  const docKey = (n: string, id: string): string => n + ' ' + id

  function sendDocWrite(n: string, change: StoreChange): void {
    void trackRequest('collection:doc-write', (i) => ({ t: 'cdwr', i, n, id: change.id, u: change.update, o: change.origin })).catch(
      (err) => {
        // A rejected write (validate-before-commit or a write-policy denial) was already applied optimistically,
        // so the replica now diverges from authoritative state. Resync from the server and hard-reset it,
        // discarding the bad edit. (A DISCONNECTED failure is left to the reconnect re-seed.)
        if (!(err instanceof SuperLineError && err.code === 'DISCONNECTED')) {
          const entry = openDocs.get(docKey(n, change.id))
          if (entry) sendDocOpen(entry, true)
        }
        if (opts.onStoreError) opts.onStoreError(err, { store: n, id: change.id })
        else console.error(`[super-line] CRDT collection write rejected for ${n}/${change.id} — resyncing`, err)
      },
    )
  }

  function sendDocOpen(entry: OpenDocEntry, reset = false): void {
    if (!rawConn?.writable) return // onOpen re-sends for every entry on (re)connect
    void trackRequest('collection:doc-open', (i) => ({ t: 'cdopen', i, n: entry.n, id: entry.id }))
      .then((snapshot) => {
        for (const replica of entry.replicas) {
          if (reset && replica.reset) replica.reset(snapshot) // reject→resync: discard the optimistic edit
          else replica.seed(snapshot) // catch-up / reconnect: merge
        }
        if (!entry.settled) {
          entry.settled = true
          entry.ready.resolve()
        }
      })
      .catch((err) => {
        if (err instanceof SuperLineError && err.code === 'DISCONNECTED') return // reconnect retries
        if (!entry.settled) {
          entry.settled = true
          entry.ready.reject(err)
        }
      })
  }

  function openDoc(n: string, id: string): DocHandle {
    if (!crdtClient)
      throw new SuperLineError('NOT_FOUND', `No CRDT collection engine configured — pass crdtCollections: crdtCollectionsClient()`)
    const def = c.collections?.[n]
    const docOpts = def && isCrdtCollection(def) ? def.crdt : undefined
    const replica = crdtClient.open(n, id, docOpts)
    const key = docKey(n, id)
    let entry = openDocs.get(key)
    if (!entry) {
      entry = { n, id, replicas: new Set(), ready: deferred(), settled: false, deleted: false }
      openDocs.set(key, entry)
    }
    entry.replicas.add(replica)
    sendDocOpen(entry)
    return {
      getSnapshot: () => replica.getSnapshot(),
      subscribe: (cb) => replica.subscribe(cb),
      set: (data) => {
        const change = replica.set(data)
        if (change) sendDocWrite(n, change)
      },
      update: (partial) => {
        const change = replica.update(partial)
        if (change) sendDocWrite(n, change)
      },
      delete: (path) => {
        const change = replica.delete(path)
        if (change) sendDocWrite(n, change)
      },
      ready: entry.ready.promise,
      get deleted() {
        return entry.deleted
      },
      close: () => {
        const e = openDocs.get(key)
        if (!e) return
        e.replicas.delete(replica)
        if (e.replicas.size === 0) {
          openDocs.delete(key)
          if (rawConn?.writable) rawConn.send(serializer.encode({ t: 'cdclose', n, id }))
        }
      },
    }
  }

  function crdtCollectionHandle(name: string): CrdtCollectionHandle {
    return { open: (id) => openDoc(name, id) }
  }

  // Route client.collection(n) by the contract's declared mode: CRDT doc collections → open-by-id handle,
  // LWW row collections → the query/batch handle.
  function collectionDispatch<N extends CollectionName<C>>(
    name: N,
  ): N extends CrdtCollectionName<C> ? CrdtCollectionHandle<DocOf<C, N>> : CollectionHandle<RowOf<C, N>> {
    const def = c.collections?.[name]
    if (!def) throw new SuperLineError('NOT_FOUND', `Collection not declared: ${name}`)
    const handle = isCrdtCollection(def) ? crdtCollectionHandle(name) : collectionHandle(name)
    return handle as N extends CrdtCollectionName<C> ? CrdtCollectionHandle<DocOf<C, N>> : CollectionHandle<RowOf<C, N>>
  }

  // ---- Collections --------------------------------------------------------
  const recomputeView = (sub: LiveSub): void => {
    sub.view = applyQuery([...sub.map.values()], sub.query) // filter (redundant, already matched) + sort + window
  }
  const notifySub = (sub: LiveSub, ev: RowSetEvent): void => {
    for (const cb of sub.listeners) cb(ev)
  }

  // Seed from a snapshot: first snapshot populates + resolves ready; a reconnect re-snapshot diffs against the
  // current rows and emits only the delta (no flicker, correct on whatever node we reconnected to).
  function seedCollection(sub: LiveSub, rows: unknown[]): void {
    const next = new Map<string, unknown>()
    for (const r of rows) {
      const id = (r as Record<string, unknown>)[sub.key]
      if (typeof id === 'string') next.set(id, r)
    }
    if (!sub.settled) {
      sub.map = next
      recomputeView(sub)
      sub.settled = true
      sub.ready.resolve()
      return
    }
    const events: RowSetEvent[] = []
    for (const id of sub.map.keys()) if (!next.has(id)) events.push({ type: 'delete', id })
    // ponytail: reconnect emits `update` for still-present rows without an equality check; add one if it causes re-render churn.
    for (const [id, row] of next) events.push({ type: sub.map.has(id) ? 'update' : 'insert', id, row })
    sub.map = next
    recomputeView(sub)
    for (const ev of events) notifySub(sub, ev)
  }

  // Apply one `cchg`, re-filtering against THIS subscription: a row matching the filter is upserted; one that no
  // longer matches (an update that left the filter) or a delete is removed.
  function applyCollectionChange(sub: LiveSub, frame: CChangeFrame): void {
    const { id } = frame
    if (frame.k === 'delete' || frame.d === undefined) {
      if (sub.map.delete(id)) {
        recomputeView(sub)
        notifySub(sub, { type: 'delete', id })
      }
      return
    }
    const row = frame.d
    if (matchesFilter(sub.query.filter, row)) {
      const was = sub.map.has(id)
      sub.map.set(id, row)
      recomputeView(sub)
      notifySub(sub, { type: was ? 'update' : 'insert', id, row })
    } else if (sub.map.delete(id)) {
      recomputeView(sub)
      notifySub(sub, { type: 'delete', id })
    }
  }

  function sendCollectionSub(sub: LiveSub): void {
    if (!rawConn?.writable) return // onOpen re-sends for every sub on (re)connect
    void trackRequest('collection:sub', (i) => ({ t: 'csub', i, n: sub.n, s: sub.subId, q: sub.query }))
      .then((snapshot) => seedCollection(sub, (snapshot as unknown[]) ?? []))
      .catch((err) => {
        if (err instanceof SuperLineError && err.code === 'DISCONNECTED') return // reconnect retries
        if (!sub.settled) {
          sub.settled = true
          sub.ready.reject(err)
        }
      })
  }

  const sendBatch = (ops: RowOp[]): Promise<void> =>
    trackRequest('collection:batch', (i) => ({ t: 'cbat', i, ops })).then(() => undefined)

  function collectionHandle(name: string): CollectionHandle {
    const def = c.collections?.[name]
    if (!def) throw new SuperLineError('NOT_FOUND', `Collection not declared: ${name}`)
    if (isCrdtCollection(def)) throw new SuperLineError('NOT_FOUND', `Collection ${name} is a CRDT document collection — use collection(n).open(id)`) // routed away by collectionDispatch; narrows def to LWW
    const key = def.key
    const idOf = (row: unknown): string => {
      const v = (row as Record<string, unknown>)[key]
      if (typeof v !== 'string') throw new SuperLineError('VALIDATION', `Collection ${name} row is missing string key '${key}'`)
      return v
    }
    return {
      subscribe(query = {}) {
        const subId = nextSubId++
        const sub: LiveSub = {
          n: name,
          subId,
          query,
          key,
          map: new Map(),
          view: [],
          listeners: new Set(),
          ready: deferred(),
          settled: false,
        }
        collectionSubs.set(subId, sub)
        let set = collectionSubsByName.get(name)
        if (!set) collectionSubsByName.set(name, (set = new Set()))
        set.add(sub)
        sendCollectionSub(sub)
        return {
          rows: () => sub.view,
          subscribe: (cb) => {
            sub.listeners.add(cb)
            return () => sub.listeners.delete(cb)
          },
          ready: sub.ready.promise,
          close: () => {
            collectionSubs.delete(subId)
            collectionSubsByName.get(name)?.delete(sub)
            if (rawConn?.writable) rawConn.send(serializer.encode({ t: 'cuns', n: name, s: subId }))
          },
        }
      },
      insert: (row) => sendBatch([{ op: 'insert', n: name, id: idOf(row), d: row }]),
      update: (row) => sendBatch([{ op: 'update', n: name, id: idOf(row), d: row }]),
      delete: (id) => sendBatch([{ op: 'delete', n: name, id }]),
      batch: (ops) =>
        sendBatch(
          ops.map((o) => (o.type === 'delete' ? { op: 'delete', n: name, id: o.id } : { op: o.type, n: name, id: idOf(o.row), d: o.row })),
        ),
    }
  }

  connect()

  const base = {
    role,
    on(event: string, handler: (data: unknown) => void): () => void {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler)
      return () => {
        const current = listeners.get(event)
        if (!current) return
        current.delete(handler)
        if (current.size === 0) listeners.delete(event)
      }
    },
    subscribe,
    collection: collectionDispatch,
    implement(handlers: Record<string, (input: unknown) => unknown>): void {
      for (const [name, handler] of Object.entries(handlers)) {
        if (handler) registerServerHandler(name, handler) // throws on a collision (plugin or a prior implement)
      }
    },
    close(): void {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      rawConn?.close()
    },
    get connected(): boolean {
      return rawConn?.writable ?? false
    },
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return (input: unknown, callOpts?: CallOptions) => call(prop, input, callOpts)
    },
  }) as unknown as SuperLineClient<C, R>
}
