import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData } from 'ws'
import {
  jsonSerializer,
  validate,
  SocketError,
  type Adapter,
  type Serializer,
  type Contract,
  type ClientFrame,
  type ReqFrame,
  type InferIn,
  type InferOut,
} from '@super-line/core'
import { Conn } from './conn.js'
import { createInMemoryAdapter } from './memory-adapter.js'

export { Conn } from './conn.js'
export { MemoryBus, createInMemoryAdapter } from './memory-adapter.js'

type Awaitable<T> = T | Promise<T>
type Messages<C extends Contract> = NonNullable<C['messages']>
type Events<C extends Contract> = NonNullable<C['events']>
type Topics<C extends Contract> = NonNullable<C['topics']>

const ROOM = 'r:'
const TOPIC = 't:'

export type MessageHandlers<C extends Contract, Ctx> = {
  [K in keyof Messages<C>]: (
    input: InferOut<Messages<C>[K]['input']>,
    ctx: Ctx,
    conn: Conn<Ctx>,
  ) => Awaitable<InferOut<Messages<C>[K]['output']>>
}

export interface MiddlewareInfo<Ctx> {
  kind: 'request' | 'subscribe'
  name: string
  conn: Conn<Ctx>
}

// Flat middleware: call next() to proceed, throw to short-circuit (reject). Does not morph ctx.
export type Middleware<Ctx> = (
  ctx: Ctx,
  info: MiddlewareInfo<Ctx>,
  next: () => Promise<void>,
) => Awaitable<void>

export interface Room<C extends Contract, Ctx> {
  add(conn: Conn<Ctx>): void
  remove(conn: Conn<Ctx>): void
  broadcast<E extends keyof Events<C>>(event: E, data: InferIn<Events<C>[E]>): void
  readonly size: number
}

export interface ServerOptions<Ctx> {
  server?: HttpServer
  serializer?: Serializer
  /** Cross-node fan-out adapter. Defaults to a per-server in-memory adapter. */
  adapter?: Adapter
  /** Only handle upgrades for this pathname; others are left untouched. */
  path?: string
  /** Runs at the HTTP upgrade. Return ctx, or throw to reject with 401. */
  authenticate?: (req: IncomingMessage) => Awaitable<Ctx>
  /** Runs on each client subscribe. Return false or throw to deny. */
  authorizeSubscribe?: (topic: string, ctx: Ctx, conn: Conn<Ctx>) => Awaitable<boolean | void>
  /** Middleware chain run before req/subscribe handlers (rate-limit, authz, logging, metrics). */
  use?: Middleware<Ctx>[]
  onConnection?: (conn: Conn<Ctx>, ctx: Ctx) => void
  onDisconnect?: (conn: Conn<Ctx>, ctx: Ctx, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo<Ctx>) => void
}

export interface SocketServer<C extends Contract, Ctx> {
  implement(handlers: MessageHandlers<C, Ctx>): SocketServer<C, Ctx>
  /** Server-controlled connection group; broadcast() sends a contract event to members. */
  room(name: string): Room<C, Ctx>
  /** Publish a message to all clients subscribed to this topic (server-only publish). */
  publish<T extends keyof Topics<C>>(topic: T, data: InferIn<Topics<C>[T]>): void
  close(): Promise<void>
}

export function createSocketServer<C extends Contract, Ctx = undefined>(
  contract: C,
  opts: ServerOptions<Ctx> = {},
): SocketServer<C, Ctx> {
  const serializer = opts.serializer ?? jsonSerializer
  const adapter = opts.adapter ?? createInMemoryAdapter()
  const wss = new WebSocketServer({ noServer: true })
  const conns = new Set<Conn<Ctx>>()
  // local members per namespaced channel (rooms + topics share this registry)
  const members = new Map<string, Set<Conn<Ctx>>>()
  let handlers: Partial<Record<string, (input: unknown, ctx: Ctx, conn: Conn<Ctx>) => unknown>> = {}

  // a frame arriving on a channel (from this node or another) is forwarded raw to local members
  adapter.onMessage((channel, payload) => {
    const set = members.get(channel)
    if (!set) return
    for (const conn of set) conn.sendRaw(payload)
  })

  function joinChannel(conn: Conn<Ctx>, channel: string): void | Promise<void> {
    conn.channels.add(channel)
    const set = members.get(channel)
    if (set) {
      set.add(conn)
      return
    }
    members.set(channel, new Set([conn]))
    return adapter.subscribe(channel) // first local member -> start receiving the channel
  }

  function leaveChannel(conn: Conn<Ctx>, channel: string): void {
    const set = members.get(channel)
    if (!set) return
    set.delete(conn)
    conn.channels.delete(channel)
    if (set.size === 0) {
      members.delete(channel)
      void adapter.unsubscribe(channel) // last local member -> stop receiving
    }
  }

  if (opts.server) {
    opts.server.on('upgrade', (req, socket, head) => {
      void handleUpgrade(req, socket, head)
    })
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (opts.path) {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')
      if (pathname !== opts.path) return
    }

    let ctx: Ctx
    try {
      ctx = opts.authenticate ? await opts.authenticate(req) : (undefined as Ctx)
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Conn<Ctx>(ws, ctx, serializer)
      conns.add(conn)
      ws.on('message', (data, isBinary) => {
        void onMessage(conn, data, isBinary)
      })
      ws.on('close', (code) => {
        conns.delete(conn)
        for (const channel of conn.channels) leaveChannel(conn, channel)
        opts.onDisconnect?.(conn, ctx, code)
      })
      opts.onConnection?.(conn, ctx)
    })
  }

  async function onMessage(conn: Conn<Ctx>, data: RawData, isBinary: boolean): Promise<void> {
    let frame: ClientFrame
    try {
      frame = serializer.decode(toWire(data, isBinary)) as ClientFrame
    } catch {
      return
    }
    if (frame.t === 'req') await handleReq(conn, frame)
    else if (frame.t === 'sub') await handleSub(conn, frame)
    else if (frame.t === 'unsub') leaveChannel(conn, TOPIC + frame.c)
  }

  function runMiddleware(info: MiddlewareInfo<Ctx>, terminal: () => Promise<void>): Promise<void> {
    const chain = opts.use ?? []
    let last = -1
    const dispatch = (idx: number): Promise<void> => {
      if (idx <= last) return Promise.reject(new Error('next() called multiple times'))
      last = idx
      const mw = chain[idx]
      if (!mw) return terminal()
      return Promise.resolve(mw(info.conn.ctx, info, () => dispatch(idx + 1)))
    }
    return dispatch(0)
  }

  async function dispatchOp(
    conn: Conn<Ctx>,
    id: number,
    info: MiddlewareInfo<Ctx>,
    terminal: () => Promise<void>,
  ): Promise<void> {
    let responded = false
    try {
      await runMiddleware(info, async () => {
        await terminal()
        responded = true
      })
    } catch (err) {
      opts.onError?.(err, info)
      if (!responded) {
        const e = err instanceof SocketError ? err : new SocketError('INTERNAL', 'Internal server error')
        conn.send({ t: 'err', i: id, code: e.code, m: e.message, d: e.data })
      }
    }
  }

  async function handleReq(conn: Conn<Ctx>, frame: ReqFrame): Promise<void> {
    const def = contract.messages?.[frame.m]
    const handler = handlers[frame.m]
    if (!def || !handler) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown message: ${frame.m}` })
      return
    }
    await dispatchOp(conn, frame.i, { kind: 'request', name: frame.m, conn }, async () => {
      const input = await validate(def.input, frame.d)
      const output = await handler(input, conn.ctx, conn)
      conn.send({ t: 'res', i: frame.i, d: output })
    })
  }

  async function handleSub(conn: Conn<Ctx>, frame: { i: number; c: string }): Promise<void> {
    await dispatchOp(conn, frame.i, { kind: 'subscribe', name: frame.c, conn }, async () => {
      if (opts.authorizeSubscribe) {
        const ok = await opts.authorizeSubscribe(frame.c, conn.ctx, conn)
        if (ok === false) throw new SocketError('FORBIDDEN', `Subscribe denied: ${frame.c}`)
      }
      await joinChannel(conn, TOPIC + frame.c) // await adapter.subscribe so ready == active
      conn.send({ t: 'res', i: frame.i, d: null })
    })
  }

  function room(name: string): Room<C, Ctx> {
    const channel = ROOM + name
    return {
      add(conn) {
        void joinChannel(conn, channel)
      },
      remove(conn) {
        leaveChannel(conn, channel)
      },
      broadcast(event, data) {
        void adapter.publish(channel, serializer.encode({ t: 'evt', e: String(event), d: data }))
      },
      get size() {
        return members.get(channel)?.size ?? 0
      },
    }
  }

  function publish<T extends keyof Topics<C>>(topic: T, data: InferIn<Topics<C>[T]>): void {
    const name = String(topic)
    void adapter.publish(TOPIC + name, serializer.encode({ t: 'pub', c: name, d: data }))
  }

  const api: SocketServer<C, Ctx> = {
    implement(h) {
      handlers = h as never
      return api
    },
    room,
    publish,
    async close() {
      for (const conn of conns) conn.close()
      await adapter.close?.()
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
    },
  }
  return api
}

function toWire(data: RawData, _isBinary: boolean): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data as Buffer
}
