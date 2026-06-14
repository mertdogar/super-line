import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData } from 'ws'
import {
  jsonSerializer,
  validate,
  SocketError,
  type Serializer,
  type Contract,
  type ClientFrame,
  type ReqFrame,
  type InferIn,
  type InferOut,
} from '@super-line/core'
import { Conn } from './conn.js'

export { Conn } from './conn.js'

type Awaitable<T> = T | Promise<T>
type Messages<C extends Contract> = NonNullable<C['messages']>
type Events<C extends Contract> = NonNullable<C['events']>

export type MessageHandlers<C extends Contract, Ctx> = {
  [K in keyof Messages<C>]: (
    input: InferOut<Messages<C>[K]['input']>,
    ctx: Ctx,
    conn: Conn<Ctx>,
  ) => Awaitable<InferOut<Messages<C>[K]['output']>>
}

export interface Room<C extends Contract, Ctx> {
  add(conn: Conn<Ctx>): void
  remove(conn: Conn<Ctx>): void
  broadcast<E extends keyof Events<C>>(event: E, data: InferIn<Events<C>[E]>): void
  readonly size: number
}

export interface ServerOptions<Ctx> {
  server?: HttpServer
  serializer?: Serializer
  /** Only handle upgrades for this pathname; others are left untouched. */
  path?: string
  /** Runs at the HTTP upgrade. Return ctx, or throw to reject with 401. */
  authenticate?: (req: IncomingMessage) => Awaitable<Ctx>
  onConnection?: (conn: Conn<Ctx>, ctx: Ctx) => void
  onDisconnect?: (conn: Conn<Ctx>, ctx: Ctx, code: number) => void
}

export interface SocketServer<C extends Contract, Ctx> {
  implement(handlers: MessageHandlers<C, Ctx>): SocketServer<C, Ctx>
  /** Server-controlled connection group; broadcast() sends a contract event to members. */
  room(name: string): Room<C, Ctx>
  close(): Promise<void>
}

export function createSocketServer<C extends Contract, Ctx = undefined>(
  contract: C,
  opts: ServerOptions<Ctx> = {},
): SocketServer<C, Ctx> {
  const serializer = opts.serializer ?? jsonSerializer
  const wss = new WebSocketServer({ noServer: true })
  const conns = new Set<Conn<Ctx>>()
  const rooms = new Map<string, Set<Conn<Ctx>>>()
  let handlers: Partial<Record<string, (input: unknown, ctx: Ctx, conn: Conn<Ctx>) => unknown>> = {}

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
        for (const name of conn.rooms) rooms.get(name)?.delete(conn)
        conn.rooms.clear()
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
    // 'sub' / 'unsub' land with the topics slice
  }

  async function handleReq(conn: Conn<Ctx>, frame: ReqFrame): Promise<void> {
    const def = contract.messages?.[frame.m]
    const handler = handlers[frame.m]
    if (!def || !handler) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown message: ${frame.m}` })
      return
    }
    try {
      const input = await validate(def.input, frame.d)
      const output = await handler(input, conn.ctx, conn)
      conn.send({ t: 'res', i: frame.i, d: output })
    } catch (err) {
      const e = err instanceof SocketError ? err : new SocketError('INTERNAL', 'Internal server error')
      conn.send({ t: 'err', i: frame.i, code: e.code, m: e.message, d: e.data })
    }
  }

  function room(name: string): Room<C, Ctx> {
    return {
      add(conn) {
        let set = rooms.get(name)
        if (!set) {
          set = new Set()
          rooms.set(name, set)
        }
        set.add(conn)
        conn.rooms.add(name)
      },
      remove(conn) {
        const set = rooms.get(name)
        if (!set) return
        set.delete(conn)
        conn.rooms.delete(name)
        if (set.size === 0) rooms.delete(name)
      },
      broadcast(event, data) {
        const set = rooms.get(name)
        if (!set) return
        const frame = { t: 'evt' as const, e: String(event), d: data }
        for (const conn of set) conn.send(frame)
      },
      get size() {
        return rooms.get(name)?.size ?? 0
      },
    }
  }

  const api: SocketServer<C, Ctx> = {
    implement(h) {
      handlers = h as never
      return api
    },
    room,
    close() {
      for (const conn of conns) conn.close()
      return new Promise<void>((resolve) => {
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
