import {
  jsonSerializer,
  validateSync,
  SuperLineError,
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
  type ClientStore,
  type ResourceReplica,
  type StoreChange,
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
  /** Client-side handle for a configured Store (`client.store('scene').open(id)`). Throws if the name isn't configured. */
  store(name: string): ClientStoreHandle
  /** Close the connection and stop reconnecting. */
  close(): void
  /** Whether the socket is currently open. */
  readonly connected: boolean
  /** This client's role. */
  readonly role: R
}

/**
 * A reactive handle over one opened Store Resource (mirrors super-store's `StoreValue` surface).
 * `data` is untyped — stores are off-contract (ADR-0003). `set`/`update` mutate the local replica and
 * write the resulting Change through to the server.
 */
export interface ResourceHandle {
  /** The current snapshot (`undefined` until the catch-up snapshot arrives). */
  getSnapshot(): unknown
  /** Subscribe to changes (local writes + remote merges). Returns an unsubscribe fn. */
  subscribe(cb: () => void): () => void
  /** Replace the value (LWW) or mutate the local doc (CRDT); the Change is sent to the server. */
  set(data: unknown): void
  /** Merge a partial update; the Change is sent to the server. */
  update(partial: unknown): void
  /** Surgically remove the value at `path` (key removal that merges, unlike a full-doc `set`); sent to the server. */
  delete(path: (string | number)[]): void
  /** Resolves once the catch-up snapshot has been applied; rejects if the open is denied. */
  readonly ready: Promise<void>
  /** Stop receiving changes and tell the server to unsubscribe. */
  close(): void
}

/** Client-side handle for one configured Store, reached via `client.store(name)`. */
export interface ClientStoreHandle {
  /** Open a reactive handle for a Resource (catch-up snapshot + live changes + write-through). */
  open(id: string): ResourceHandle
  /** One-shot read of a Resource's current value. */
  read(id: string): Promise<unknown>
  /** One-shot replace of a Resource's value (last-writer-wins). */
  write(id: string, data: unknown): Promise<void>
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
   * Client halves of the Store pairs, keyed by name to match the server's `stores`
   * (`{ scene: crdtStoreClient(), config: memoryStoreClient() }`). Surfaced as `client.store(name)`.
   */
  stores?: Record<string, ClientStore>
  /** Called when a store write is rejected by the server (e.g. FORBIDDEN). Default: logs to console. */
  onStoreError?: (error: unknown, info: { store: string; id: string }) => void
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
  const storeMap = (opts.stores ?? {}) as Record<string, ClientStore>
  // opened Resources, keyed `name\0id`: routes inbound `sch` to the local replicas and re-snapshots on reconnect
  interface OpenEntry {
    store: string
    id: string
    replicas: Set<ResourceReplica>
    ready: Deferred
    settled: boolean
  }
  const openResources = new Map<string, OpenEntry>()
  const openKey = (store: string, id: string): string => store + '\u0000' + id

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
    for (const entry of openResources.values()) sendOpen(entry) // re-snapshot opened Resources (at-most-once recovery)
  }

  function onClose(): void {
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
    } else if (frame.t === 'sch') {
      const entry = openResources.get(openKey(frame.n, frame.id))
      if (entry) {
        const change = { id: frame.id, update: frame.u, origin: frame.o }
        for (const replica of entry.replicas) replica.applyRemote(change) // own-origin merges are no-ops
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

  // Store request/response correlation reuses the `requests` map: store ops get a res/err carrying the same
  // `i`, and `reqDef('store:*')` is undefined so inbound validation is skipped. One-shot ops (read/write)
  // ride the generic unsent-resend on reconnect; opens are driven by `sendOpen` + the onOpen entry loop.
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

  function sendStoreWrite(store: string, change: StoreChange): void {
    void trackRequest('store:write', (i) => ({ t: 'swr', i, n: store, id: change.id, u: change.update, o: change.origin })).catch(
      (err) => {
        if (opts.onStoreError) opts.onStoreError(err, { store, id: change.id })
        else console.error(`[super-line] store write rejected for ${store}/${change.id}`, err)
      },
    )
  }

  // Send `sopen` and seed every replica of the entry. Resolves the entry's `ready` on first catch-up; a
  // disconnect mid-open is retried by onOpen (don't settle), an explicit denial settles+rejects.
  function sendOpen(entry: OpenEntry): void {
    if (!rawConn?.writable) return // onOpen re-sends for every entry on (re)connect
    void trackRequest('store:open', (i) => ({ t: 'sopen', i, n: entry.store, id: entry.id }))
      .then((snapshot) => {
        for (const replica of entry.replicas) replica.seed(snapshot)
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

  function openResource(store: string, clientStore: ClientStore, id: string): ResourceHandle {
    const replica = clientStore.open(id)
    const key = openKey(store, id)
    let entry = openResources.get(key)
    if (!entry) {
      entry = { store, id, replicas: new Set(), ready: deferred(), settled: false }
      openResources.set(key, entry)
    }
    entry.replicas.add(replica)
    sendOpen(entry) // seeds this replica (and harmlessly re-seeds siblings)
    return {
      getSnapshot: () => replica.getSnapshot(),
      subscribe: (cb) => replica.subscribe(cb),
      set: (data) => {
        const change = replica.set(data)
        if (change) sendStoreWrite(store, change)
      },
      update: (partial) => {
        const change = replica.update(partial)
        if (change) sendStoreWrite(store, change)
      },
      delete: (path) => {
        const change = replica.delete(path)
        if (change) sendStoreWrite(store, change)
      },
      ready: entry.ready.promise,
      close: () => {
        const e = openResources.get(key)
        if (!e) return
        e.replicas.delete(replica)
        if (e.replicas.size === 0) {
          openResources.delete(key)
          if (rawConn?.writable) rawConn.send(serializer.encode({ t: 'sclose', n: store, id }))
        }
      },
    }
  }

  function storeHandle(name: string): ClientStoreHandle {
    const clientStore = storeMap[name]
    if (!clientStore) throw new SuperLineError('NOT_FOUND', `Store not configured: ${name}`)
    return {
      open: (id) => openResource(name, clientStore, id),
      read: (id) => trackRequest('store:read', (i) => ({ t: 'srd', i, n: name, id })),
      write: (id, data) =>
        trackRequest('store:write', (i) => ({ t: 'swr', i, n: name, id, u: data, o: clientStore.origin })).then(
          () => undefined,
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
    store: storeHandle,
    implement(handlers: Record<string, (input: unknown) => unknown>): void {
      for (const [name, handler] of Object.entries(handlers)) {
        if (handler) serverHandlers.set(name, handler)
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
