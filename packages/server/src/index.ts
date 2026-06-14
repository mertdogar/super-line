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
  type InferOut,
} from '@super-line/core'
import { Conn } from './conn.js'

export { Conn } from './conn.js'

type Awaitable<T> = T | Promise<T>

type Messages<C extends Contract> = NonNullable<C['messages']>

export type MessageHandlers<C extends Contract, Ctx> = {
  [K in keyof Messages<C>]: (
    input: InferOut<Messages<C>[K]['input']>,
    ctx: Ctx,
    conn: Conn<Ctx>,
  ) => Awaitable<InferOut<Messages<C>[K]['output']>>
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

export interface SocketServer<Ctx> {
  implement<C extends Contract>(contract: C, handlers: MessageHandlers<C, Ctx>): SocketServer<Ctx>
  close(): Promise<void>
}

export function createSocketServer<Ctx = undefined>(
  opts: ServerOptions<Ctx> = {},
): SocketServer<Ctx> {
  const serializer = opts.serializer ?? jsonSerializer
  const wss = new WebSocketServer({ noServer: true })
  const conns = new Set<Conn<Ctx>>()

  let contract: Contract | undefined
  let handlers: Record<string, (input: unknown, ctx: Ctx, conn: Conn<Ctx>) => unknown> = {}

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
    const def = contract?.messages?.[frame.m]
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

  const api: SocketServer<Ctx> = {
    implement(c, h) {
      contract = c
      handlers = h as never
      return api
    },
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
