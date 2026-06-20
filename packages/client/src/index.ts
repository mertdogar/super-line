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
  /** Close the connection and stop reconnecting. */
  close(): void
  /** Whether the socket is currently open. */
  readonly connected: boolean
  /** This client's role. */
  readonly role: R
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
  /** The server URL, e.g. `ws://localhost:3000`. */
  url: string
  /** This client's role; narrows the surface and is sent to the server to verify. */
  role: R
  /** Extra query params appended to the URL (read in `authenticate`); `role` is added automatically. */
  params?: Record<string, string>
  /** Wire serializer; MUST match the server. Defaults to `jsonSerializer`. */
  serializer?: Serializer
  /** Default request timeout in ms. Defaults to `30000`. */
  timeoutMs?: number
  /** `'inbound'` re-validates server→client payloads against the contract (catches drift). Default `'off'`. */
  validate?: 'off' | 'inbound'
  /** Called when an inbound payload fails validation (only with `validate: 'inbound'`). */
  onValidationError?: (error: unknown, info: ValidationErrorInfo) => void
  /** Auto-reconnect on drop. Defaults to `true`. */
  reconnect?: boolean
  /** Initial reconnect backoff in ms. Defaults to `500`. */
  reconnectBaseMs?: number
  /** Maximum reconnect backoff in ms. Defaults to `30000`. */
  reconnectMaxMs?: number
  /** Backoff growth factor. Defaults to `2`. */
  reconnectFactor?: number
  /** Override the WebSocket implementation (defaults to `globalThis.WebSocket`). */
  WebSocket?: typeof WebSocket
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
 * const client = createSuperLineClient(api, { url: 'ws://localhost:3000', role: 'user', params: { token } })
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
  const resolved = opts.WebSocket ?? (globalThis.WebSocket as typeof WebSocket | undefined)
  if (!resolved) throw new Error('No WebSocket implementation found; pass opts.WebSocket')
  const WS: typeof WebSocket = resolved

  // role rides along as a query param so the server's authenticate can verify it
  const url = buildUrl(opts.url, { ...opts.params, role })
  const requests = new Map<number, Request>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const topicListeners = new Map<string, Set<(data: unknown) => void>>()
  const readyByTopic = new Map<string, Deferred>() // topics awaiting their first ack
  const subAckById = new Map<number, string>() // outstanding sub frame id -> topic
  const serverHandlers = new Map<string, (input: unknown) => unknown>() // answer server→client requests

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

  let ws!: WebSocket
  let nextId = 1
  let closed = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function connect(): void {
    ws = new WS(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = onOpen
    ws.onmessage = (event: MessageEvent) => {
      onMessage(event.data as string | ArrayBuffer)
    }
    ws.onclose = onClose
  }

  function onOpen(): void {
    attempt = 0
    for (const op of requests.values()) {
      if (!op.sent) {
        ws.send(op.frame)
        op.sent = true
      }
    }
    for (const topic of topicListeners.keys()) sendSub(topic)
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

  function onMessage(data: string | ArrayBuffer): void {
    let frame: ServerFrame
    try {
      frame = serializer.decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data) as ServerFrame
    } catch {
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
    }
  }

  async function handleServerRequest(frame: SReqFrame): Promise<void> {
    const send = (f: object) => {
      if (ws.readyState === WS.OPEN) ws.send(serializer.encode(f))
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
      if (ws.readyState === WS.OPEN) {
        ws.send(frame)
        op.sent = true
      }
    })
  }

  function sendSub(topic: string): void {
    const id = nextId++
    subAckById.set(id, topic)
    ws.send(serializer.encode({ t: 'sub', i: id, c: topic }))
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
      if (ws.readyState === WS.OPEN) sendSub(topic) // else onOpen re-subscribes
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
          if (ws.readyState === WS.OPEN) ws.send(serializer.encode({ t: 'unsub', c: topic }))
        }
      },
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
    implement(handlers: Record<string, (input: unknown) => unknown>): void {
      for (const [name, handler] of Object.entries(handlers)) {
        if (handler) serverHandlers.set(name, handler)
      }
    },
    close(): void {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.close()
    },
    get connected(): boolean {
      return ws.readyState === WS.OPEN
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

function buildUrl(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value)
  return u.toString()
}
