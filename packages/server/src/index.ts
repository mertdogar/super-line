import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
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
  type EvtFrame,
  type RoleOf,
  type Events,
  type SharedRequests,
  type RoleRequests,
  type SharedEvents,
  type SharedTopics,
  type RoleTopics,
  type ServerEvents,
  type ServerInput,
  type ClientInput,
  type Output,
  type EmitData,
  type ServerEmit,
  type ServerData,
  type ConnDescriptor,
  type NodeStat,
  type PresenceStore,
  type SharedServerRequests,
} from '@super-line/core'
import { Conn, type Backpressure } from './conn.js'
import { createInMemoryAdapter } from './memory-adapter.js'

export { Conn, type Backpressure } from './conn.js'
export { MemoryBus, createInMemoryAdapter } from './memory-adapter.js'

type Awaitable<T> = T | Promise<T>

/**
 * The discriminated value `authenticate` returns: a `role` (one of the contract's
 * roles) plus its `ctx`. Returning different ctx shapes per role narrows both the
 * handler surface and `ctx` together.
 */
export type AuthResult<C extends Contract> = {
  [R in RoleOf<C>]: { role: R; ctx: unknown }
}[RoleOf<C>]
type CtxFor<A, R> = A extends { role: R; ctx: infer X } ? X : never
type CtxUnion<A> = A extends { ctx: infer X } ? X : never

const ROOM = 'r:'
const TOPIC = 't:'
const CONN = 'c:' // personal channel per connection (targeted cross-node send)
const USER = 'u:' // personal channel per user key (cross-node fan-out)
const REPLY = 'reply:' // per-node channel carrying server→client request replies back to the origin
const S2S = 's2s' // reserved channel for inter-server messaging

// Envelope carried on personal (c:/u:) channels — distinct from the raw frame fan-out of rooms/topics.
type PersonalEnvelope =
  | { p: 'emit'; f: EvtFrame }
  | { p: 'close' }
  | { p: 'req'; o: string; i: number; m: string; d: unknown } // server→client request from origin node `o`
// Reply to a server→client request, routed back to the origin node on its REPLY channel.
type ReplyEnvelope =
  | { i: number; ok: true; d: unknown }
  | { i: number; ok: false; code: string; m: string; d?: unknown }

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

/**
 * The handler map passed to `implement`: one block per role plus an optional
 * `shared` block. Each handler's `input`/`ctx`/`conn` are narrowed to its role.
 * The `shared` key is required only when the contract has shared requests.
 */
export type Handlers<C extends Contract, A> = ([keyof SharedRequests<C>] extends [never]
  ? {}
  : { shared: SharedHandlers<C, A> }) & {
  [R in RoleOf<C>]: RoleHandlers<C, A, R>
}

/** Context passed to middleware and lifecycle hooks about the current operation. */
export interface MiddlewareInfo {
  /** Whether this is a request or a topic subscribe. */
  kind: 'request' | 'subscribe'
  /** The request/topic name. */
  name: string
  /** The connection the operation is on (`conn.role` available). */
  conn: Conn
}

/**
 * Flat middleware run before request/subscribe handlers. Call `next()` to proceed,
 * or `throw` to short-circuit (rejecting the operation). Does not change `ctx`'s type.
 */
export type Middleware<A> = (
  ctx: CtxUnion<A>,
  info: MiddlewareInfo,
  next: () => Promise<void>,
) => Awaitable<void>

/**
 * A mixed-role, server-controlled connection group. `broadcast` delivers a
 * **shared** event to every member, regardless of their role.
 */
export interface Room<C extends Contract> {
  /** Add a connection to the room (server-controlled membership). */
  add(conn: Conn): void
  /** Remove a connection from the room. */
  remove(conn: Conn): void
  /** Broadcast a shared event to all members. */
  broadcast<E extends keyof SharedEvents<C>>(event: E, data: EmitData<SharedEvents<C>[E]>): void
  /** Member count **on the current node** (membership is node-local). */
  readonly size: number
  /** Snapshot of this room's members **on the current node**. */
  readonly connections: Conn[]
}

/** Synchronous, node-local introspection of the current server process. */
export interface LocalView {
  /** Snapshot of all connections accepted on this node. */
  readonly connections: Conn[]
  /** Names of rooms with at least one member on this node. */
  readonly rooms: string[]
  /** Names of topics with at least one subscriber on this node. */
  readonly topics: string[]
}

/**
 * Asynchronous, cluster-wide introspection backed by the adapter's presence
 * directory. Methods reject if the configured adapter has no presence support.
 */
export interface ClusterView {
  /** Every live connection across the cluster. */
  connections(): Promise<ConnDescriptor[]>
  /** Total live connection count across the cluster. */
  count(): Promise<number>
  /** Connections for a given user key (the `identify` hook). */
  byUser(userId: string): Promise<ConnDescriptor[]>
  /** Connections that are members of `room`, across nodes. */
  room(name: string): Promise<ConnDescriptor[]>
  /** Per-node aggregates (the other nodes and their counts). */
  topology(): Promise<NodeStat[]>
}

/** A single targeted connection, reachable on whatever node holds it. */
export interface ConnTarget<C extends Contract> {
  /** Push a shared event to this connection (cross-node). */
  emit<E extends keyof SharedEvents<C>>(event: E, data: EmitData<SharedEvents<C>[E]>): void
  /**
   * Send a shared server→client request and await the client's typed reply
   * (cross-node). Rejects with a `TIMEOUT` `SocketError` if no live node owns
   * the connection or the client doesn't answer in time.
   */
  request<M extends keyof SharedServerRequests<C>>(
    name: M,
    input: ClientInput<SharedServerRequests<C>[M]>,
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<Output<SharedServerRequests<C>[M]>>
  /** Close this connection (cross-node kick). */
  close(): void
}

/** All of a user's connections (0..N devices), reachable across nodes. */
export interface UserTarget<C extends Contract> {
  /** Push a shared event to every one of the user's connections (cross-node). */
  emit<E extends keyof SharedEvents<C>>(event: E, data: EmitData<SharedEvents<C>[E]>): void
  /** Disconnect every one of the user's connections (cross-node). */
  disconnect(): void
}

/** Lens for role-scoped server sends, returned by `srv.forRole(role)`. */
export interface RoleLens<C extends Contract, R extends RoleOf<C>> {
  /** Publish to a topic in role `R`'s surface (reaches that role's subscribers). */
  publish<T extends keyof RoleTopics<C, R>>(topic: T, data: EmitData<RoleTopics<C, R>[T]>): void
}

/** Options for {@link createSocketServer}. */
export interface ServerOptions<C extends Contract, A extends AuthResult<C>> {
  /** The `http.Server` to attach to (compose with Express/Fastify/Hono). */
  server?: HttpServer
  /** Wire serializer; MUST match the client. Defaults to `jsonSerializer`. */
  serializer?: Serializer
  /** Cross-node fan-out adapter. Defaults to a per-server in-memory adapter. */
  adapter?: Adapter
  /** Only handle upgrades for this pathname; others are left untouched. */
  path?: string
  /** Runs at the HTTP upgrade. Return { role, ctx }, or throw to reject with 401. */
  authenticate: (req: IncomingMessage) => Awaitable<A>
  /** Stable user key for a connection (powers `cluster.byUser`, `isOnline`, and `toUser`). */
  identify?: (conn: Conn) => string | undefined
  /** Extra fields merged into the connection's cluster descriptor (e.g. `{ plan }`). `ctx` is never auto-serialized. */
  describeConn?: (conn: Conn) => Record<string, unknown>
  /** Runs on each client subscribe. Return false or throw to deny. */
  authorizeSubscribe?: (topic: string, ctx: CtxUnion<A>, conn: Conn) => Awaitable<boolean | void>
  /** Middleware chain run before req/subscribe handlers (rate-limit, authz, logging, metrics). */
  use?: Middleware<A>[]
  /**
   * Heartbeat: one timer pings every connection each `interval` ms (updating
   * `conn.lastPingAt`/`lastPongAt`). Set `maxMissed` to terminate a connection
   * that misses that many consecutive pongs. `false` disables it.
   * Defaults to `{ interval: 30_000 }` (no reaping).
   */
  heartbeat?: { interval?: number; maxMissed?: number } | false
  /** Guard against slow consumers: when a connection's send buffer exceeds the limit, close or drop. */
  backpressure?: Backpressure
  /** Called once per accepted connection. */
  onConnection?: (conn: Conn, ctx: CtxUnion<A>) => void
  /** Called when a connection closes, with the WebSocket close `code`. */
  onDisconnect?: (conn: Conn, ctx: CtxUnion<A>, code: number) => void
  /** Called for any error thrown in middleware/handlers (after the client is replied to). */
  onError?: (error: unknown, info: MiddlewareInfo) => void
}

/** A running super-line server, returned by {@link createSocketServer}. */
export interface SocketServer<C extends Contract, A extends AuthResult<C>> {
  /** This node's stable id (unique per server process). */
  readonly nodeId: string
  /** Synchronous, node-local introspection (connections, rooms, topics on this process). */
  readonly local: LocalView
  /** Asynchronous, cluster-wide introspection backed by the adapter's presence directory. */
  readonly cluster: ClusterView
  /** Whether a user (by `identify` key) has at least one live connection anywhere. */
  isOnline(userId: string): Promise<boolean>
  /** Target a single connection by id, on whatever node holds it (cross-node emit/close). */
  toConn(id: string): ConnTarget<C>
  /** Target all of a user's connections (by `identify` key) across nodes (emit/disconnect). */
  toUser(userId: string): UserTarget<C>
  /** Register handlers for shared + per-role requests (chainable). */
  implement(handlers: Handlers<C, A>): SocketServer<C, A>
  /** Mixed-role connection group; broadcast() sends a shared contract event to members. */
  room(name: string): Room<C>
  /** Publish a SHARED topic to all subscribers (server-only publish). */
  publish<T extends keyof SharedTopics<C>>(topic: T, data: EmitData<SharedTopics<C>[T]>): void
  /** Lens for role-scoped sends, e.g. forRole('user').publish('feed', data). */
  forRole<R extends RoleOf<C>>(role: R): RoleLens<C, R>
  /** Broadcast a typed event to all OTHER server nodes (at-most-once, excludes self). */
  emitServer<E extends keyof ServerEvents<C>>(event: E, data: ServerEmit<ServerEvents<C>[E]>): void
  /** Listen for inter-server events from other nodes. Returns an unsubscribe fn. */
  onServer<E extends keyof ServerEvents<C>>(
    event: E,
    handler: (data: ServerData<ServerEvents<C>[E]>) => void,
  ): () => void
  close(): Promise<void>
}

type AnyHandler = (input: unknown, ctx: unknown, conn: Conn) => unknown
type Impl = Record<string, Record<string, AnyHandler>>

/**
 * Create a server bound to a contract. Attach it to an `http.Server`, then call
 * {@link SocketServer.implement} with your handlers. `authenticate` resolves each
 * connection's `{ role, ctx }` at the upgrade.
 *
 * @param contract - the shared contract.
 * @param opts - server options; `authenticate` is required.
 * @returns the {@link SocketServer}.
 * @throws nothing directly; handler throws become a typed `SocketError` to the client.
 *
 * @example
 * ```ts
 * const srv = createSocketServer(api, {
 *   server,
 *   authenticate: (req) => ({ role: 'user' as const, ctx: { id: '1' } }),
 * })
 * srv.implement({
 *   shared: { join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } } },
 *   user:   { say:  async ({ text }, ctx)        => ({ id: '...' }) },
 * })
 * ```
 */
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
  const serverListeners = new Map<string, Set<(data: unknown) => void>>()
  const instanceId = randomUUID() // identifies this node; lets emitServer exclude itself
  const replyChannel = REPLY + instanceId
  let impl: Impl = {}
  let closing = false // close() is idempotent

  // server→client request bookkeeping (one counter, two roles a node can play)
  let nextSReq = 1
  type Waiter = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }
  const originWaiters = new Map<number, Waiter>() // requests THIS node originated, awaiting a reply
  const ownerRouting = new Map<number, { origin: string; corrId: number; name: string }>() // sreq sent to a local client on behalf of `origin`

  function buildDescriptor(conn: Conn): ConnDescriptor {
    const userId = opts.identify?.(conn)
    const rooms: string[] = []
    for (const ch of conn.channels) if (ch.startsWith(ROOM)) rooms.push(ch.slice(ROOM.length))
    return {
      id: conn.id,
      role: conn.role,
      nodeId: instanceId,
      connectedAt: conn.connectedAt,
      ...(userId !== undefined ? { userId } : {}),
      rooms,
      ...opts.describeConn?.(conn),
    }
  }

  function presenceOrThrow(): PresenceStore {
    if (!adapter.presence) throw new Error('cluster queries require an adapter with presence support')
    return adapter.presence
  }

  // a frame arriving on a channel (from this node or another) is forwarded raw to local members
  adapter.onMessage((channel, payload) => {
    if (channel === S2S) {
      handleServerMessage(payload)
      return
    }
    if (channel === replyChannel) {
      handleReply(payload)
      return
    }
    if (channel.startsWith(CONN) || channel.startsWith(USER)) {
      handlePersonal(channel, payload)
      return
    }
    const set = members.get(channel)
    if (!set) return
    for (const conn of set) conn.sendRaw(payload)
  })

  // the server→client request feature subscribes its reply channel up front (one per node)
  void adapter.subscribe(replyChannel)

  // personal (c:/u:) channels carry a control envelope, not a raw frame to forward verbatim
  function handlePersonal(channel: string, payload: string | Uint8Array): void {
    const set = members.get(channel)
    if (!set) return
    let env: PersonalEnvelope
    try {
      env = serializer.decode(payload) as PersonalEnvelope
    } catch {
      return
    }
    if (env.p === 'close') {
      for (const conn of set) conn.close()
      return
    }
    if (env.p === 'req') {
      // owner side: forward to the local client under a fresh local id, remember where to reply
      const localId = nextSReq++
      ownerRouting.set(localId, { origin: env.o, corrId: env.i, name: env.m })
      for (const conn of set) conn.send({ t: 'sreq', i: localId, m: env.m, d: env.d })
      return
    }
    const frame = serializer.encode(env.f)
    for (const conn of set) conn.sendRaw(frame)
  }

  // a request reply arrived for something THIS node originated -> settle the waiter
  function handleReply(payload: string | Uint8Array): void {
    let env: ReplyEnvelope
    try {
      env = serializer.decode(payload) as ReplyEnvelope
    } catch {
      return
    }
    const w = originWaiters.get(env.i)
    if (!w) return
    originWaiters.delete(env.i)
    if (w.timer) clearTimeout(w.timer)
    if (env.ok) w.resolve(env.d)
    else w.reject(new SocketError(env.code, env.m, env.d))
  }

  // owner side: the local client answered an sreq -> route the reply back to the origin node
  async function handleClientReply(
    conn: Conn,
    localId: number,
    result: { ok: true; d: unknown } | { ok: false; code: string; m: string; d?: unknown },
  ): Promise<void> {
    const r = ownerRouting.get(localId)
    if (!r) return
    ownerRouting.delete(localId)
    let env: ReplyEnvelope
    if (result.ok) {
      try {
        const def = c.roles[conn.role]?.serverToClient?.[r.name] ?? c.shared?.serverToClient?.[r.name]
        const out = def && 'output' in def ? await validate(def.output, result.d) : result.d
        env = { i: r.corrId, ok: true, d: out }
      } catch (err) {
        const e = err instanceof SocketError ? err : new SocketError('INTERNAL', 'Internal server error')
        env = { i: r.corrId, ok: false, code: e.code, m: e.message, d: e.data }
      }
    } else {
      env = { i: r.corrId, ok: false, code: result.code, m: result.m, d: result.d }
    }
    void adapter.publish(REPLY + r.origin, serializer.encode(env))
  }

  // inter-server messaging rides the adapter on a reserved channel; subscribe if used
  if (c.serverToServer) void adapter.subscribe(S2S)

  // one heartbeat timer: ping every conn (for lastPongAt liveness) + optional reaping
  const hb = opts.heartbeat === false ? null : opts.heartbeat ?? {}
  let hbTimer: ReturnType<typeof setInterval> | undefined
  if (hb) {
    hbTimer = setInterval(() => {
      const now = Date.now()
      void adapter.presence?.beat(instanceId)
      for (const conn of conns) {
        if (hb.maxMissed != null && conn.missedPongs >= hb.maxMissed) {
          conn.ws.terminate()
          continue
        }
        conn.missedPongs++
        conn.lastPingAt = now
        conn.ws.ping()
      }
    }, hb.interval ?? 30_000)
    hbTimer.unref?.()
  }

  function handleServerMessage(payload: string | Uint8Array): void {
    let msg: { from: string; e: string; d: unknown }
    try {
      msg = serializer.decode(payload) as { from: string; e: string; d: unknown }
    } catch {
      return
    }
    if (msg.from === instanceId) return // exclude self
    const set = serverListeners.get(msg.e)
    if (set) for (const cb of set) cb(msg.d)
  }

  function joinChannel(conn: Conn, channel: string): void | Promise<void> {
    conn.channels.add(channel)
    if (channel.startsWith(ROOM)) void adapter.presence?.addRoom(conn.id, channel.slice(ROOM.length))
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
    if (channel.startsWith(ROOM)) void adapter.presence?.removeRoom(conn.id, channel.slice(ROOM.length))
    if (set.size === 0) {
      members.delete(channel)
      void adapter.unsubscribe(channel) // last local member -> stop receiving
    }
  }

  // Where a topic lives for this conn: its role channel, the shared channel, or nowhere.
  function isTopic(name: string, block: { serverToClient?: Record<string, unknown> } | undefined): boolean {
    const def = block?.serverToClient?.[name]
    return !!def && typeof def === 'object' && 'subscribe' in def && def.subscribe === true
  }
  function topicNamespace(role: string, name: string): string | undefined {
    if (isTopic(name, c.roles[role])) return role
    if (isTopic(name, c.shared)) return 'shared'
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
      const conn = new Conn(ws, randomUUID(), auth.role, auth.ctx, serializer, opts.backpressure)
      conns.add(conn)
      void adapter.presence?.set(buildDescriptor(conn))
      void joinChannel(conn, CONN + conn.id) // personal channel for targeted cross-node send
      const uid = opts.identify?.(conn)
      if (uid !== undefined) void joinChannel(conn, USER + uid)
      ws.on('pong', () => {
        conn.lastPongAt = Date.now()
        conn.missedPongs = 0
      })
      ws.on('message', (data, isBinary) => {
        void onMessage(conn, data, isBinary)
      })
      ws.on('close', (code) => {
        conns.delete(conn)
        for (const channel of conn.channels) leaveChannel(conn, channel)
        void adapter.presence?.del(conn.id)
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
    } else if (frame.t === 'sres') {
      await handleClientReply(conn, frame.i, { ok: true, d: frame.d })
    } else if (frame.t === 'serr') {
      await handleClientReply(conn, frame.i, { ok: false, code: frame.code, m: frame.m, d: frame.d })
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
      get connections() {
        return [...(members.get(channel) ?? [])]
      },
    }
  }

  function publishTo(ns: string, name: string, data: unknown): void {
    void adapter.publish(TOPIC + ns + ':' + name, serializer.encode({ t: 'pub', c: name, d: data }))
  }

  // emit/close to a personal (c:/u:) channel; the owning node delivers via handlePersonal
  function personalTarget(channel: string): {
    emit: (event: string, data: unknown) => void
    close: () => void
  } {
    return {
      emit(event, data) {
        const env: PersonalEnvelope = { p: 'emit', f: { t: 'evt', e: event, d: data } }
        void adapter.publish(channel, serializer.encode(env))
      },
      close() {
        void adapter.publish(channel, serializer.encode({ p: 'close' } satisfies PersonalEnvelope))
      },
    }
  }

  // server→client request: publish a req envelope to the conn's personal channel and await the reply
  function requestConn(
    id: string,
    name: string,
    input: unknown,
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const reqId = nextSReq++
    return new Promise<unknown>((resolve, reject) => {
      const ms = opts?.timeout ?? 30_000
      const timer =
        ms > 0
          ? setTimeout(() => {
              originWaiters.delete(reqId)
              reject(new SocketError('TIMEOUT', `Request '${name}' timed out`))
            }, ms)
          : undefined
      originWaiters.set(reqId, { resolve, reject, timer })
      opts?.signal?.addEventListener(
        'abort',
        () => {
          if (originWaiters.delete(reqId)) {
            if (timer) clearTimeout(timer)
            reject(new SocketError('BAD_REQUEST', 'Aborted'))
          }
        },
        { once: true },
      )
      const env: PersonalEnvelope = { p: 'req', o: instanceId, i: reqId, m: name, d: input }
      void adapter.publish(CONN + id, serializer.encode(env))
    })
  }

  const api: SocketServer<C, A> = {
    nodeId: instanceId,
    get local(): LocalView {
      return {
        connections: [...conns],
        get rooms() {
          const out: string[] = []
          for (const channel of members.keys()) if (channel.startsWith(ROOM)) out.push(channel.slice(ROOM.length))
          return out
        },
        get topics() {
          const out: string[] = []
          for (const channel of members.keys()) {
            if (!channel.startsWith(TOPIC)) continue
            out.push(channel.slice(channel.indexOf(':', TOPIC.length) + 1)) // strip "t:{ns}:"
          }
          return out
        },
      }
    },
    cluster: {
      async connections() {
        return presenceOrThrow().list()
      },
      async count() {
        return presenceOrThrow().count()
      },
      async byUser(userId) {
        return presenceOrThrow().byUser(userId)
      },
      async room(name) {
        return presenceOrThrow().roomMembers(name)
      },
      async topology() {
        return presenceOrThrow().topology()
      },
    },
    async isOnline(userId) {
      return (await presenceOrThrow().byUser(userId)).length > 0
    },
    toConn(id) {
      const t = personalTarget(CONN + id)
      return {
        emit: t.emit,
        close: t.close,
        request: (name, input, opts) => requestConn(id, String(name), input, opts),
      } as ConnTarget<C>
    },
    toUser(userId) {
      const t = personalTarget(USER + userId)
      return { emit: t.emit, disconnect: t.close }
    },
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
    emitServer(event, data) {
      void adapter.publish(S2S, serializer.encode({ from: instanceId, e: String(event), d: data }))
    },
    onServer(event, handler) {
      const name = String(event)
      let set = serverListeners.get(name)
      if (!set) {
        set = new Set()
        serverListeners.set(name, set)
      }
      set.add(handler as (data: unknown) => void)
      return () => {
        const current = serverListeners.get(name)
        if (!current) return
        current.delete(handler as (data: unknown) => void)
        if (current.size === 0) serverListeners.delete(name)
      }
    },
    async close() {
      if (closing) return
      closing = true
      if (hbTimer) clearInterval(hbTimer)
      for (const conn of conns) conn.close()
      await adapter.presence?.clearNode(instanceId) // remove this node's registry entries before disconnecting
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
