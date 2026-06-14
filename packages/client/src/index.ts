import {
  jsonSerializer,
  validateSync,
  SocketError,
  type Schema,
  type Serializer,
  type Contract,
  type ServerFrame,
  type InferIn,
  type InferOut,
} from '@super-line/core'
import { backoffDelay } from './backoff.js'

export { backoffDelay } from './backoff.js'
export type { BackoffOptions } from './backoff.js'

type Messages<C extends Contract> = NonNullable<C['messages']>
type Events<C extends Contract> = NonNullable<C['events']>
type Topics<C extends Contract> = NonNullable<C['topics']>

export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface Subscription {
  /** Resolves when the server acknowledges the subscribe; rejects if denied. */
  readonly ready: Promise<void>
  unsubscribe(): void
}

export type ClientMethods<C extends Contract> = {
  [K in keyof Messages<C>]: (
    input: InferIn<Messages<C>[K]['input']>,
    opts?: CallOptions,
  ) => Promise<InferOut<Messages<C>[K]['output']>>
}

export type Client<C extends Contract> = ClientMethods<C> & {
  on<E extends keyof Events<C>>(
    event: E,
    handler: (data: InferOut<Events<C>[E]>) => void,
  ): () => void
  subscribe<T extends keyof Topics<C>>(
    topic: T,
    handler: (data: InferOut<Topics<C>[T]>) => void,
  ): Subscription
  close(): void
  readonly connected: boolean
}

export interface ValidationErrorInfo {
  kind: 'response' | 'event' | 'topic'
  name: string
}

export interface ClientOptions {
  url: string
  params?: Record<string, string>
  serializer?: Serializer
  timeoutMs?: number
  /** 'inbound' re-validates server->client payloads against the contract (catches drift). Default 'off'. */
  validate?: 'off' | 'inbound'
  onValidationError?: (error: unknown, info: ValidationErrorInfo) => void
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  reconnectFactor?: number
  /** Override the WebSocket implementation (defaults to globalThis.WebSocket). */
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

export function createClient<C extends Contract>(contract: C, opts: ClientOptions): Client<C> {
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

  const url = buildUrl(opts.url, opts.params)
  const requests = new Map<number, Request>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const topicListeners = new Map<string, Set<(data: unknown) => void>>()
  const readyByTopic = new Map<string, Deferred>() // topics awaiting their first ack
  const subAckById = new Map<number, string>() // outstanding sub frame id -> topic

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
        op.reject(new SocketError('DISCONNECTED', 'Connection closed'))
        requests.delete(id)
      }
    }
    subAckById.clear() // acks won't arrive; reconnect re-subscribes

    if (closed || !reconnectEnabled) {
      for (const [id, op] of requests) {
        if (op.timer) clearTimeout(op.timer)
        op.reject(new SocketError('DISCONNECTED', 'Connection closed'))
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
          const def = contract.messages?.[op.method]
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
          r.reject(new SocketError(frame.code, frame.m, frame.d))
        }
        topicListeners.delete(topic) // denied -> drop local listeners
        return
      }
      settleRequest(frame.i, (op) => op.reject(new SocketError(frame.code, frame.m, frame.d)))
    } else if (frame.t === 'evt') {
      if (!checkInbound(contract.events?.[frame.e], frame.d, { kind: 'event', name: frame.e })) return
      const set = listeners.get(frame.e)
      if (set) for (const cb of set) cb(frame.d)
    } else if (frame.t === 'pub') {
      if (!checkInbound(contract.topics?.[frame.c], frame.d, { kind: 'topic', name: frame.c })) return
      const set = topicListeners.get(frame.c)
      if (set) for (const cb of set) cb(frame.d)
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
    if (closed) return Promise.reject(new SocketError('DISCONNECTED', 'Client closed'))
    const id = nextId++
    const frame = serializer.encode({ t: 'req', i: id, m: method, d: input })
    return new Promise<unknown>((resolve, reject) => {
      const ms = callOpts?.timeoutMs ?? defaultTimeout
      const timer =
        ms > 0
          ? setTimeout(() => {
              requests.delete(id)
              reject(new SocketError('TIMEOUT', `Request '${method}' timed out`))
            }, ms)
          : undefined
      const op: Request = { method, frame, resolve, reject, timer, sent: false }
      requests.set(id, op)
      callOpts?.signal?.addEventListener(
        'abort',
        () => {
          if (requests.delete(id)) {
            if (timer) clearTimeout(timer)
            reject(new SocketError('BAD_REQUEST', 'Aborted'))
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
  }) as unknown as Client<C>
}

function buildUrl(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value)
  return u.toString()
}
