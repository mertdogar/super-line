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
  type RoleOf,
  type Events,
  type SharedRequests,
  type RoleRequests,
  type SharedEvents,
  type SharedTopics,
  type RoleTopics,
  type ServerInput,
  type Output,
  type EmitData,
} from '@super-line/core'
import { Conn } from './conn.js'
import { createInMemoryAdapter } from './memory-adapter.js'

export { Conn } from './conn.js'
export { MemoryBus, createInMemoryAdapter } from './memory-adapter.js'

type Awaitable<T> = T | Promise<T>

// The discriminated value authenticate returns: a role + its ctx, per role.
export type AuthResult<C extends Contract> = {
  [R in RoleOf<C>]: { role: R; ctx: unknown }
}[RoleOf<C>]
type CtxFor<A, R> = A extends { role: R; ctx: infer X } ? X : never
type CtxUnion<A> = A extends { ctx: infer X } ? X : never

const ROOM = 'r:'
const TOPIC = 't:'

// Handlers for one role's clientToServer requests. ctx + conn are narrowed to that role.
type RoleHandlers<C extends Contract, A, R extends RoleOf<C>> = {
  [K in keyof RoleRequests<C, R>]: (
    input: ServerInput<RoleRequests<C, R>[K]>,
    ctx: CtxFor<A, R>,
    conn: Conn<Events<C, R>, CtxFor<A, R>, R>,
  ) => Awaitable<Output<RoleRequests<C, R>[K]>>
}

// Handlers for shared requests (any role). ctx is the union; conn may emit only shared events.
type SharedHandlers<C extends Contract, A> = {
  [K in keyof SharedRequests<C>]: (
    input: ServerInput<SharedRequests<C>[K]>,
    ctx: CtxUnion<A>,
    conn: Conn<SharedEvents<C>, CtxUnion<A>, RoleOf<C>>,
  ) => Awaitable<Output<SharedRequests<C>[K]>>
}

// `shared` key only required when the contract actually has shared requests.
export type Handlers<C extends Contract, A> = ([keyof SharedRequests<C>] extends [never]
  ? {}
  : { shared: SharedHandlers<C, A> }) & {
  [R in RoleOf<C>]: RoleHandlers<C, A, R>
}

export interface MiddlewareInfo {
  kind: 'request' | 'subscribe'
  name: string
  conn: Conn
}

// Flat middleware: call next() to proceed, throw to short-circuit (reject). Does not morph ctx.
export type Middleware<A> = (
  ctx: CtxUnion<A>,
  info: MiddlewareInfo,
  next: () => Promise<void>,
) => Awaitable<void>

// Mixed-role connection group. broadcast() delivers a SHARED event to all members.
export interface Room<C extends Contract> {
  add(conn: Conn): void
  remove(conn: Conn): void
  broadcast<E extends keyof SharedEvents<C>>(event: E, data: EmitData<SharedEvents<C>[E]>): void
  readonly size: number
}

// Role lens for role-scoped server sends.
export interface RoleLens<C extends Contract, R extends RoleOf<C>> {
  publish<T extends keyof RoleTopics<C, R>>(topic: T, data: EmitData<RoleTopics<C, R>[T]>): void
}

export interface ServerOptions<C extends Contract, A extends AuthResult<C>> {
  server?: HttpServer
  serializer?: Serializer
  /** Cross-node fan-out adapter. Defaults to a per-server in-memory adapter. */
  adapter?: Adapter
  /** Only handle upgrades for this pathname; others are left untouched. */
  path?: string
  /** Runs at the HTTP upgrade. Return { role, ctx }, or throw to reject with 401. */
  authenticate: (req: IncomingMessage) => Awaitable<A>
  /** Runs on each client subscribe. Return false or throw to deny. */
  authorizeSubscribe?: (topic: string, ctx: CtxUnion<A>, conn: Conn) => Awaitable<boolean | void>
  /** Middleware chain run before req/subscribe handlers (rate-limit, authz, logging, metrics). */
  use?: Middleware<A>[]
  onConnection?: (conn: Conn, ctx: CtxUnion<A>) => void
  onDisconnect?: (conn: Conn, ctx: CtxUnion<A>, code: number) => void
  onError?: (error: unknown, info: MiddlewareInfo) => void
}

export interface SocketServer<C extends Contract, A extends AuthResult<C>> {
  implement(handlers: Handlers<C, A>): SocketServer<C, A>
  /** Mixed-role connection group; broadcast() sends a shared contract event to members. */
  room(name: string): Room<C>
  /** Publish a SHARED topic to all subscribers (server-only publish). */
  publish<T extends keyof SharedTopics<C>>(topic: T, data: EmitData<SharedTopics<C>[T]>): void
  /** Lens for role-scoped sends, e.g. forRole('user').publish('feed', data). */
  forRole<R extends RoleOf<C>>(role: R): RoleLens<C, R>
  close(): Promise<void>
}

type AnyHandler = (input: unknown, ctx: unknown, conn: Conn) => unknown
type Impl = Record<string, Record<string, AnyHandler>>

export function createSocketServer<C extends Contract, A extends AuthResult<C>>(
  contract: C,
  opts: ServerOptions<C, A>,
): SocketServer<C, A> {
  const c: Contract = contract
  const serializer = opts.serializer ?? jsonSerializer
  const adapter = opts.adapter ?? createInMemoryAdapter()
  const wss = new WebSocketServer({ noServer: true })
  const conns = new Set<Conn>()
  // local members per namespaced channel (rooms + topics share this registry)
  const members = new Map<string, Set<Conn>>()
  let impl: Impl = {}

  // a frame arriving on a channel (from this node or another) is forwarded raw to local members
  adapter.onMessage((channel, payload) => {
    const set = members.get(channel)
    if (!set) return
    for (const conn of set) conn.sendRaw(payload)
  })

  function joinChannel(conn: Conn, channel: string): void | Promise<void> {
    conn.channels.add(channel)
    const set = members.get(channel)
    if (set) {
      set.add(conn)
      return
    }
    members.set(channel, new Set([conn]))
    return adapter.subscribe(channel) // first local member -> start receiving the channel
  }

  function leaveChannel(conn: Conn, channel: string): void {
    const set = members.get(channel)
    if (!set) return
    set.delete(conn)
    conn.channels.delete(channel)
    if (set.size === 0) {
      members.delete(channel)
      void adapter.unsubscribe(channel) // last local member -> stop receiving
    }
  }

  // Where a topic lives for this conn: its role channel, the shared channel, or nowhere.
  function topicNamespace(role: string, name: string): string | undefined {
    if (c.roles[role]?.serverToClient?.[name]?.subscribe) return role
    if (c.shared?.serverToClient?.[name]?.subscribe) return 'shared'
    return undefined
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

    let auth: A
    try {
      auth = await opts.authenticate(req)
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Conn(ws, auth.role, auth.ctx, serializer)
      conns.add(conn)
      ws.on('message', (data, isBinary) => {
        void onMessage(conn, data, isBinary)
      })
      ws.on('close', (code) => {
        conns.delete(conn)
        for (const channel of conn.channels) leaveChannel(conn, channel)
        opts.onDisconnect?.(conn, auth.ctx as CtxUnion<A>, code)
      })
      opts.onConnection?.(conn, auth.ctx as CtxUnion<A>)
    })
  }

  async function onMessage(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    let frame: ClientFrame
    try {
      frame = serializer.decode(toWire(data, isBinary)) as ClientFrame
    } catch {
      return
    }
    if (frame.t === 'req') await handleReq(conn, frame)
    else if (frame.t === 'sub') await handleSub(conn, frame)
    else if (frame.t === 'unsub') {
      const ns = topicNamespace(conn.role, frame.c)
      if (ns) leaveChannel(conn, TOPIC + ns + ':' + frame.c)
    }
  }

  function runMiddleware(info: MiddlewareInfo, terminal: () => Promise<void>): Promise<void> {
    const chain = opts.use ?? []
    let last = -1
    const dispatch = (idx: number): Promise<void> => {
      if (idx <= last) return Promise.reject(new Error('next() called multiple times'))
      last = idx
      const mw = chain[idx]
      if (!mw) return terminal()
      return Promise.resolve(mw(info.conn.ctx as CtxUnion<A>, info, () => dispatch(idx + 1)))
    }
    return dispatch(0)
  }

  async function dispatchOp(
    conn: Conn,
    id: number,
    info: MiddlewareInfo,
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

  async function handleReq(conn: Conn, frame: ReqFrame): Promise<void> {
    // resolving by role inherently enforces the boundary: a cross-role method is unknown here
    const def = c.roles[conn.role]?.clientToServer?.[frame.m] ?? c.shared?.clientToServer?.[frame.m]
    const handler = impl[conn.role]?.[frame.m] ?? impl.shared?.[frame.m]
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

  async function handleSub(conn: Conn, frame: { i: number; c: string }): Promise<void> {
    const ns = topicNamespace(conn.role, frame.c)
    if (!ns) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown topic: ${frame.c}` })
      return
    }
    await dispatchOp(conn, frame.i, { kind: 'subscribe', name: frame.c, conn }, async () => {
      if (opts.authorizeSubscribe) {
        const ok = await opts.authorizeSubscribe(frame.c, conn.ctx as CtxUnion<A>, conn)
        if (ok === false) throw new SocketError('FORBIDDEN', `Subscribe denied: ${frame.c}`)
      }
      await joinChannel(conn, TOPIC + ns + ':' + frame.c) // await adapter.subscribe so ready == active
      conn.send({ t: 'res', i: frame.i, d: null })
    })
  }

  function room(name: string): Room<C> {
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

  function publishTo(ns: string, name: string, data: unknown): void {
    void adapter.publish(TOPIC + ns + ':' + name, serializer.encode({ t: 'pub', c: name, d: data }))
  }

  const api: SocketServer<C, A> = {
    implement(handlers) {
      impl = handlers as unknown as Impl
      return api
    },
    room,
    publish(topic, data) {
      publishTo('shared', String(topic), data)
    },
    forRole(role) {
      return {
        publish(topic, data) {
          publishTo(role, String(topic), data)
        },
      }
    },
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
