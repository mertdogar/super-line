import {
  jsonSerializer,
  SocketError,
  type Serializer,
  type Contract,
  type ServerFrame,
  type InferIn,
  type InferOut,
} from '@super-line/core'

type Messages<C extends Contract> = NonNullable<C['messages']>
type Events<C extends Contract> = NonNullable<C['events']>

export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export type ClientMethods<C extends Contract> = {
  [K in keyof Messages<C>]: (
    input: InferIn<Messages<C>[K]['input']>,
    opts?: CallOptions,
  ) => Promise<InferOut<Messages<C>[K]['output']>>
}

export type Client<C extends Contract> = ClientMethods<C> & {
  /** Listen for a server-pushed event (also how room broadcasts arrive). Returns an unsubscribe fn. */
  on<E extends keyof Events<C>>(
    event: E,
    handler: (data: InferOut<Events<C>[E]>) => void,
  ): () => void
  close(): void
  readonly connected: boolean
}

export interface ClientOptions {
  url: string
  params?: Record<string, string>
  serializer?: Serializer
  timeoutMs?: number
  /** Override the WebSocket implementation (defaults to globalThis.WebSocket). */
  WebSocket?: typeof WebSocket
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export function createClient<C extends Contract>(_contract: C, opts: ClientOptions): Client<C> {
  const serializer = opts.serializer ?? jsonSerializer
  const defaultTimeout = opts.timeoutMs ?? 30_000
  const resolved = opts.WebSocket ?? (globalThis.WebSocket as typeof WebSocket | undefined)
  if (!resolved) throw new Error('No WebSocket implementation found; pass opts.WebSocket')
  const WS: typeof WebSocket = resolved

  const url = buildUrl(opts.url, opts.params)
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const outbox: Array<string | Uint8Array> = []
  let ws!: WebSocket
  let nextId = 1
  let closed = false

  function connect(): void {
    ws = new WS(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      for (const frame of outbox.splice(0)) ws.send(frame)
    }
    ws.onmessage = (event: MessageEvent) => {
      onMessage(event.data as string | ArrayBuffer)
    }
    ws.onclose = () => {
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(new SocketError('DISCONNECTED', 'Connection closed'))
      }
      pending.clear()
    }
  }

  function onMessage(data: string | ArrayBuffer): void {
    let frame: ServerFrame
    try {
      frame = serializer.decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data) as ServerFrame
    } catch {
      return
    }
    if (frame.t === 'res') {
      settle(frame.i, (p) => p.resolve(frame.d))
    } else if (frame.t === 'err' && frame.i !== undefined) {
      settle(frame.i, (p) => p.reject(new SocketError(frame.code, frame.m, frame.d)))
    } else if (frame.t === 'evt') {
      const set = listeners.get(frame.e)
      if (set) for (const cb of set) cb(frame.d)
    }
    // 'pub' lands with the topics slice
  }

  function settle(id: number, run: (p: Pending) => void): void {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    run(p)
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
              pending.delete(id)
              reject(new SocketError('TIMEOUT', `Request '${method}' timed out`))
            }, ms)
          : undefined
      pending.set(id, { resolve, reject, timer })
      callOpts?.signal?.addEventListener(
        'abort',
        () => settle(id, (p) => p.reject(new SocketError('BAD_REQUEST', 'Aborted'))),
        { once: true },
      )
      if (ws.readyState === WS.OPEN) ws.send(frame)
      else outbox.push(frame)
    })
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
    close(): void {
      closed = true
      ws.close()
    },
    get connected(): boolean {
      return ws.readyState === WS.OPEN
    },
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      // never expose `then` as a method, or the client becomes an accidental thenable
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
