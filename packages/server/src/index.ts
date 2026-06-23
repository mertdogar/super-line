import { randomUUID } from 'node:crypto'
import {
  jsonSerializer,
  validate,
  SuperLineError,
  INSPECTOR_ROLE,
  classifyContract,
  type Adapter,
  type Serializer,
  type Schema,
  type Contract,
  type InspectedContract,
  type ConnView,
  type InspectorEvent,
  type ServerTransport,
  type RawConn,
  type Handshake,
  type AuthOutcome,
  type ClientFrame,
  type ReqFrame,
  type EvtFrame,
  type PubFrame,
  type SOpenFrame,
  type SCloseFrame,
  type SWriteFrame,
  type SReadFrame,
  type SChangeFrame,
  type ServerStore,
  type Resource,
  type AccessRules,
  type Perms,
  type EventData,
  type RoleOf,
  type Events,
  type SharedRequests,
  type RoleRequests,
  type SharedEvents,
  type SharedTopics,
  type RoleTopics,
  type ServerInput,
  type ClientInput,
  type Output,
  type EmitData,
  type ConnDescriptor,
  type NodeStat,
  type PresenceStore,
  type SharedServerRequests,
  type DataOf,
  type AnyData,
} from '@super-line/core'
import { Conn, resolvePrincipal } from './conn.js'
import { createInMemoryAdapter } from './memory-adapter.js'

export { Conn, resolvePrincipal } from './conn.js'
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
const INSPECT = 'i:' // reserved fan-out channel for the inspector `events` topic
const STORE = 's:' // per-Resource fan-out channel: `s:<name>:<id>`
const SERVER_ORIGIN = 'server' // origin stamped on server co-writes (distinct from any client writer id)

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
    conn: Conn<Events<C, R>, CtxFor<A, R>, R, DataOf<C, R>>,
  ) => Awaitable<Output<RoleRequests<C, R>[K]>>
}

// Handlers for shared requests (any role). ctx is the union; conn may emit only shared events.
type SharedHandlers<C extends Contract, A> = {
  [K in keyof SharedRequests<C>]: (
    input: ServerInput<SharedRequests<C>[K]>,
    ctx: CtxUnion<A>,
    conn: Conn<SharedEvents<C>, CtxUnion<A>, RoleOf<C>, AnyData<C>>,
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
  /** Whether this is a request, a topic subscribe, or a bus event delivery. */
  kind: 'request' | 'subscribe' | 'event'
  /** The request/topic/event name. */
  name: string
  /** The connection the operation is on, if any (`conn.role` available). Absent for bus events. */
  conn?: Conn
}

/** Metadata passed to a {@link SuperLineServer.subscribe} callback alongside the event payload. */
export interface BusMeta {
  /** The node that published the event. Equals `srv.nodeId` for a same-node publish (local echo). */
  from: string
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
   * (cross-node). Rejects with a `TIMEOUT` `SuperLineError` if no live node owns
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

/**
 * Server-side handle for one configured Store, reached via `srv.store.<name>`. The server is
 * authoritative: it creates Resources, grants/revokes access, and may co-write. `data` is untyped
 * (stores are off-contract — see ADR-0003); callers assert the shape.
 */
export interface ServerStoreHandle {
  /** Create a Resource with initial data + access rules (deny-by-default for everyone unlisted). */
  create(id: string, data: unknown, accessRules: AccessRules): Promise<void>
  /** Read a Resource (data + accessRules), or undefined if absent. */
  read(id: string): Promise<Resource | undefined>
  /** Server co-write: replace the Resource's value (LWW), fanned out to subscribers with a `server` origin. */
  write(id: string, data: unknown): Promise<void>
  /** Grant a principal read/write on a Resource. */
  grant(id: string, principal: string, perms: Perms): Promise<void>
  /** Revoke a principal's access to a Resource entirely. */
  revoke(id: string, principal: string): Promise<void>
  /** Delete a Resource. */
  delete(id: string): Promise<void>
  /** All Resource ids in this store. */
  list(): Promise<string[]>
}

/** Options for {@link createSuperLineServer}. */
export interface SuperLineServerOptions<C extends Contract, A extends AuthResult<C>> {
  /** Client↔server transports to accept connections on (e.g. `webSocketServerTransport({ server })`). */
  transports: ServerTransport[]
  /** Wire serializer; MUST match the client. Defaults to `jsonSerializer`. */
  serializer?: Serializer
  /** Cross-node fan-out adapter. Defaults to a per-server in-memory adapter. */
  adapter?: Adapter
  /**
   * Friendly name for this node, surfaced in `srv.nodeName`, the cluster descriptor, and the
   * Control Center topology. Defaults to `SUPER_LINE_NODE_NAME` or a short slice of `nodeId`.
   */
  nodeName?: string
  /** Authenticate a connection from its normalized {@link Handshake}. Return { role, ctx }, or throw to reject. */
  authenticate: (handshake: Handshake) => Awaitable<A>
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
  /**
   * Enable the read-only Control Center inspector: emit `msg.*` telemetry and accept inspector
   * clients. The WS transport must also be created with `inspector: true` to negotiate the
   * `superline.inspector.v1` subprotocol. **Default off; dev / trusted-network only.**
   */
  inspector?: boolean | { redact?: string[] }
  /**
   * Pluggable persisted-state Stores, keyed by name (`{ scene: crdtStoreServer(), config: memoryStoreServer() }`).
   * Each is the server half of a Store pair; the client passes the matching client halves. Surfaced as
   * `srv.store.<name>` and `client.store.<name>`. Stores are off-contract and untyped (ADR-0003).
   */
  stores?: Record<string, ServerStore>
  /** Called once per accepted connection. */
  onConnection?: (conn: Conn, ctx: CtxUnion<A>) => void
  /** Called when a connection closes, with the WebSocket close `code`. */
  onDisconnect?: (conn: Conn, ctx: CtxUnion<A>, code: number) => void
  /** Called for any error thrown in middleware/handlers (after the client is replied to). */
  onError?: (error: unknown, info: MiddlewareInfo) => void
}

/** A running super-line server, returned by {@link createSuperLineServer}. */
export interface SuperLineServer<C extends Contract, A extends AuthResult<C>> {
  /** This node's stable id (unique per server process). */
  readonly nodeId: string
  /** This node's friendly name (from `nodeName`/`SUPER_LINE_NODE_NAME`, else a short `nodeId` slice). */
  readonly nodeName: string
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
  implement(handlers: Handlers<C, A>): SuperLineServer<C, A>
  /** Mixed-role connection group; broadcast() sends a shared contract event to members. */
  room(name: string): Room<C>
  /** Publish a SHARED topic to all subscribers (server-only publish). */
  publish<T extends keyof SharedTopics<C>>(topic: T, data: EmitData<SharedTopics<C>[T]>): void
  /**
   * Subscribe SERVER-side to a shared topic, cluster-wide. The callback fires for a
   * publish from any node — including this one (local echo, delivered in-process with
   * no round-trip). `meta.from` is the publishing node; self-exclude with
   * `if (meta.from === srv.nodeId) return`. Returns an unsubscribe fn.
   */
  subscribe<T extends keyof SharedTopics<C>>(
    topic: T,
    handler: (data: EventData<SharedTopics<C>[T]>, meta: BusMeta) => void,
  ): () => void
  /** Lens for role-scoped sends, e.g. forRole('user').publish('feed', data). */
  forRole<R extends RoleOf<C>>(role: R): RoleLens<C, R>
  /** Server-authoritative handle for a configured Store (`srv.store('scene').create(...)`). Throws `NOT_FOUND` if the name isn't configured. */
  store(name: string): ServerStoreHandle
  close(): Promise<void>
}

type AnyHandler = (input: unknown, ctx: unknown, conn: Conn) => unknown
type Impl = Record<string, Record<string, AnyHandler>>

/**
 * Create a server bound to a contract. Attach it to an `http.Server`, then call
 * {@link SuperLineServer.implement} with your handlers. `authenticate` resolves each
 * connection's `{ role, ctx }` at the upgrade.
 *
 * @param contract - the shared contract.
 * @param opts - server options; `authenticate` is required.
 * @returns the {@link SuperLineServer}.
 * @throws nothing directly; handler throws become a typed `SuperLineError` to the client.
 *
 * @example
 * ```ts
 * const srv = createSuperLineServer(api, {
 *   transports: [webSocketServerTransport({ server })],
 *   authenticate: (h) => ({ role: 'user' as const, ctx: { id: '1' } }),
 * })
 * srv.implement({
 *   shared: { join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } } },
 *   user:   { say:  async ({ text }, ctx)        => ({ id: '...' }) },
 * })
 * ```
 */
export function createSuperLineServer<C extends Contract, A extends AuthResult<C>>(
  contract: C,
  opts: SuperLineServerOptions<C, A>,
): SuperLineServer<C, A> {
  const c: Contract = contract
  const serializer = opts.serializer ?? jsonSerializer
  const adapter = opts.adapter ?? createInMemoryAdapter()
  const inspectorEnabled = !!opts.inspector
  const inspectorRedact = new Set<string>(
    opts.inspector && typeof opts.inspector === 'object' ? opts.inspector.redact ?? [] : [],
  )
  const storeMap = (opts.stores ?? {}) as Record<string, ServerStore>
  const conns = new Set<Conn>()
  const inspectorConns = new Set<Conn>() // read-only inspectors: kept out of conns/presence/heartbeat
  // local members per namespaced channel (rooms + topics share this registry)
  const members = new Map<string, Set<Conn>>()
  // server-side bus subscribers per topic channel (parallel to `members` which holds conns)
  const busListeners = new Map<string, Set<(data: unknown, meta: BusMeta) => void>>()
  const instanceId = randomUUID() // identifies this node; lets the bus drop its own looped-back echo
  const nodeName = opts.nodeName ?? process.env.SUPER_LINE_NODE_NAME ?? instanceId.slice(0, 8)
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
      nodeName,
      connectedAt: conn.connectedAt,
      ...(userId !== undefined ? { userId } : {}),
      rooms,
      ...(conn.transport !== undefined ? { transport: conn.transport } : {}),
      ...opts.describeConn?.(conn),
    }
  }

  function presenceOrThrow(): PresenceStore {
    if (!adapter.presence) throw new Error('cluster queries require an adapter with presence support')
    return adapter.presence
  }

  // a frame arriving on a channel (from this node or another) is forwarded raw to local members
  adapter.onMessage((channel, payload) => {
    if (channel === replyChannel) {
      handleReply(payload)
      return
    }
    if (channel.startsWith(CONN) || channel.startsWith(USER)) {
      handlePersonal(channel, payload)
      return
    }
    const set = members.get(channel)
    if (set) for (const conn of set) conn.sendRaw(payload)
    const busSet = busListeners.get(channel)
    if (busSet) deliverBus(payload, busSet)
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
    else w.reject(new SuperLineError(env.code, env.m, env.d))
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
        const e = err instanceof SuperLineError ? err : new SuperLineError('INTERNAL', 'Internal server error')
        env = { i: r.corrId, ok: false, code: e.code, m: e.message, d: e.data }
      }
    } else {
      env = { i: r.corrId, ok: false, code: result.code, m: result.m, d: result.d }
    }
    if (inspectorEnabled)
      emitInspectorEvent(
        env.ok
          ? { type: 'msg.serverReply', target: conn.id, name: r.name, ok: true, output: safeSnapshot(env.d) }
          : {
              type: 'msg.serverReply',
              target: conn.id,
              name: r.name,
              ok: false,
              error: { code: env.code, message: env.m },
            },
      )
    void adapter.publish(REPLY + r.origin, serializer.encode(env))
  }

  // one heartbeat timer: ping every conn (for lastPongAt liveness) + optional reaping
  const hb = opts.heartbeat === false ? null : opts.heartbeat ?? {}
  let hbTimer: ReturnType<typeof setInterval> | undefined
  if (hb) {
    hbTimer = setInterval(() => {
      const now = Date.now()
      void adapter.presence?.beat(instanceId)
      for (const conn of conns) {
        if (hb.maxMissed != null && conn.missedPongs >= hb.maxMissed) {
          conn.terminate()
          continue
        }
        conn.missedPongs++
        conn.lastPingAt = now
        // app-level liveness frame: deliberately goes through the normal send path, so a connection
        // over its backpressure limit is closed/dropped here like any other slow consumer.
        conn.send({ t: 'ping' })
      }
    }, hb.interval ?? 30_000)
    hbTimer.unref?.()
  }

  // publish a live topology event to subscribed inspectors (fans out cluster-wide via the adapter)
  function emitInspectorEvent(event: InspectorEvent): void {
    if (!inspectorEnabled) return
    void adapter.publish(INSPECT + 'events', serializer.encode({ t: 'pub', c: 'events', d: event }))
  }

  function joinChannel(conn: Conn, channel: string): void | Promise<void> {
    conn.channels.add(channel)
    if (channel.startsWith(ROOM)) {
      const room = channel.slice(ROOM.length)
      void adapter.presence?.addRoom(conn.id, room)
      emitInspectorEvent({ type: 'room.add', connId: conn.id, room })
    } else if (channel.startsWith(TOPIC)) {
      emitInspectorEvent({ type: 'topic.sub', connId: conn.id, topic: channel.slice(channel.indexOf(':', TOPIC.length) + 1) })
    }
    const set = members.get(channel)
    if (set) {
      set.add(conn)
      return
    }
    const alreadySubscribed = busListeners.has(channel) // a server-side subscriber may already hold it
    members.set(channel, new Set([conn]))
    if (!alreadySubscribed) return adapter.subscribe(channel) // first local member of either kind
  }

  function leaveChannel(conn: Conn, channel: string): void {
    const set = members.get(channel)
    if (!set) return
    set.delete(conn)
    conn.channels.delete(channel)
    if (channel.startsWith(ROOM)) {
      const room = channel.slice(ROOM.length)
      void adapter.presence?.removeRoom(conn.id, room)
      emitInspectorEvent({ type: 'room.remove', connId: conn.id, room })
    } else if (channel.startsWith(TOPIC)) {
      emitInspectorEvent({ type: 'topic.unsub', connId: conn.id, topic: channel.slice(channel.indexOf(':', TOPIC.length) + 1) })
    }
    if (set.size === 0) {
      members.delete(channel)
      if (!busListeners.has(channel)) void adapter.unsubscribe(channel) // no conns or bus subs left
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

  function localRooms(): string[] {
    const out: string[] = []
    for (const channel of members.keys()) if (channel.startsWith(ROOM)) out.push(channel.slice(ROOM.length))
    return out
  }
  function localTopics(): string[] {
    const out: string[] = []
    for (const channel of members.keys()) {
      if (!channel.startsWith(TOPIC)) continue
      out.push(channel.slice(channel.indexOf(':', TOPIC.length) + 1)) // strip "t:{ns}:"
    }
    return out
  }

  // inspector connections dispatch against the fixed InspectorContract, never the user's contract
  async function onInspectorFrame(conn: Conn, frame: ClientFrame): Promise<void> {
    if (frame.t === 'req') await handleInspectorReq(conn, frame)
    else if (frame.t === 'sub') await handleInspectorSub(conn, frame)
    else if (frame.t === 'unsub') leaveChannel(conn, INSPECT + 'events')
  }

  async function handleInspectorSub(conn: Conn, frame: { i: number; c: string }): Promise<void> {
    if (frame.c !== 'events') {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown topic: ${frame.c}` })
      return
    }
    await joinChannel(conn, INSPECT + 'events') // await subscribe so the ack means "receiving"
    conn.send({ t: 'res', i: frame.i, d: null })
  }

  async function handleInspectorReq(conn: Conn, frame: ReqFrame): Promise<void> {
    const handler = inspectorHandlers[frame.m]
    if (!handler) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown message: ${frame.m}` })
      return
    }
    try {
      const output = await handler(frame.d, conn)
      conn.send({ t: 'res', i: frame.i, d: output })
    } catch (err) {
      const e = err instanceof SuperLineError ? err : new SuperLineError('INTERNAL', 'Internal server error')
      conn.send({ t: 'err', i: frame.i, code: e.code, m: e.message, d: e.data })
    }
  }

  // getContract structure + best-effort JSON Schema via lazy, optional @standard-community/standard-json.
  // The package (and the per-vendor converter) is optional — missing/unsupported falls back to structure only.
  async function buildInspectedContract(): Promise<InspectedContract> {
    let toJsonSchema: (s: Schema) => Promise<unknown>
    try {
      const mod = await import('@standard-community/standard-json')
      toJsonSchema = mod.toJsonSchema as unknown as (s: Schema) => Promise<unknown>
    } catch {
      return classifyContract(c) // converter package not installed -> structure only
    }
    const schemas = new Set<Schema>()
    classifyContract(c, (s) => {
      schemas.add(s)
      return undefined
    })
    const converted = new Map<Schema, unknown>()
    await Promise.all(
      [...schemas].map((s) =>
        toJsonSchema(s).then(
          (j) => {
            converted.set(s, j)
          },
          () => {}, // unsupported vendor / missing per-vendor converter -> structure-only for this entry
        ),
      ),
    )
    return classifyContract(c, (s) => converted.get(s))
  }

  // best-effort, never-throwing snapshot of ctx/conn.data for the inspector (node-local, display-only)
  function safeSnapshot(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null) return null
    const t = typeof value
    if (t === 'bigint') return `${(value as bigint).toString()}n`
    if (t === 'function') return '[Function]'
    if (t === 'symbol') return (value as symbol).toString()
    if (t !== 'object') return value // string | number | boolean | undefined
    const obj = value as object
    if (obj instanceof Date) return obj.toISOString()
    if (seen.has(obj)) return '[Circular]'
    if (depth >= 6) return '[MaxDepth]'
    seen.add(obj)
    try {
      if (Array.isArray(obj)) return obj.slice(0, 1000).map((v) => safeSnapshot(v, depth + 1, seen))
      const ctor = (Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null)?.constructor?.name
      const out: Record<string, unknown> = {}
      if (ctor && ctor !== 'Object') out['#type'] = ctor
      for (const [k, v] of Object.entries(obj)) {
        out[k] = inspectorRedact.has(k) ? '[Redacted]' : safeSnapshot(v, depth + 1, seen)
      }
      return out
    } finally {
      seen.delete(obj)
    }
  }

  const inspectorHandlers: Record<string, (input: unknown, conn: Conn) => Promise<unknown>> = {
    getContract: () => buildInspectedContract(),
    getTopology: async () => presenceOrThrow().topology(),
    listConnections: async () => presenceOrThrow().list(),
    getNode: async () => ({ nodeId: instanceId, nodeName, rooms: localRooms(), topics: localTopics() }),
    getConn: async (input) => {
      const id = (input as { id?: string } | undefined)?.id
      if (!id) throw new SuperLineError('BAD_REQUEST', 'getConn requires an id')
      const local = [...conns].find((cn) => cn.id === id)
      if (local) {
        return {
          descriptor: buildDescriptor(local),
          ctx: safeSnapshot(local.ctx),
          data: safeSnapshot(local.data),
          ctxAvailable: true,
        } satisfies ConnView
      }
      const remote = await presenceOrThrow().get(id) // on another node: descriptor only, no ctx
      if (!remote) throw new SuperLineError('NOT_FOUND', `Unknown connection: ${id}`)
      return { descriptor: remote, ctxAvailable: false } satisfies ConnView
    },
  }

  // Core owns the auth decision; each transport calls this at its native moment and rejects natively on throw.
  const authHook = async (handshake: Handshake): Promise<AuthOutcome> => {
    const auth = await opts.authenticate(handshake)
    return { role: auth.role, ctx: auth.ctx, transport: handshake.transport }
  }

  // A transport accepted (and authenticated) a connection — wire it up. Inspector conns
  // (role === INSPECTOR_ROLE, set by the transport) are observer-invisible.
  function acceptConn(raw: RawConn, auth: AuthOutcome): void {
    const role = auth.role
    const ctx = auth.ctx
    const inspector = role === INSPECTOR_ROLE
    if (inspector && !inspectorEnabled) {
      raw.close() // server-authoritative: refuse an inspector a transport offered but this server didn't enable
      return
    }
    const connId = randomUUID()
    const conn = new Conn(
      raw,
      connId,
      role,
      ctx,
      serializer,
      inspectorEnabled
        ? (event, data) =>
            emitInspectorEvent({ type: 'msg.event', target: connId, name: event, data: safeSnapshot(data) })
        : undefined,
    )
    conn.transport = auth.transport
    conn.principal = resolvePrincipal(conn, opts.identify) // ACL identity for stores; always defined
    raw.onMessage((bytes) => {
      void onMessage(conn, bytes)
    })

    if (inspector) {
      // observer-invisible: not in conns/presence/heartbeat, no lifecycle hooks
      inspectorConns.add(conn)
      raw.onClose(() => {
        inspectorConns.delete(conn)
        for (const channel of conn.channels) leaveChannel(conn, channel) // drop its events subscription
      })
      return
    }

    conns.add(conn)
    raw.onClose((code) => {
      conns.delete(conn)
      for (const channel of conn.channels) leaveChannel(conn, channel)
      void adapter.presence?.del(conn.id)
      const goneUserId = opts.identify?.(conn) // carry the name so the feed can label a purged conn
      emitInspectorEvent({
        type: 'disconnect',
        connId: conn.id,
        nodeId: instanceId,
        ...(goneUserId !== undefined ? { userId: goneUserId } : {}),
      })
      opts.onDisconnect?.(conn, ctx as CtxUnion<A>, code)
    })
    opts.onConnection?.(conn, ctx as CtxUnion<A>) // may seed conn.data before the snapshot
    const descriptor = buildDescriptor(conn) // snapshot (reads conn.data)
    void adapter.presence?.set(descriptor)
    emitInspectorEvent({ type: 'connect', descriptor })
    void joinChannel(conn, CONN + conn.id) // personal channel for targeted cross-node send
    const uid = opts.identify?.(conn)
    if (uid !== undefined) void joinChannel(conn, USER + uid)
  }

  async function onMessage(conn: Conn, bytes: Uint8Array): Promise<void> {
    let frame: ClientFrame
    try {
      frame = serializer.decode(bytes) as ClientFrame
    } catch {
      return
    }
    if (inspectorConns.has(conn)) {
      await onInspectorFrame(conn, frame)
      return
    }
    if (frame.t === 'req') await handleReq(conn, frame)
    else if (frame.t === 'sub') await handleSub(conn, frame)
    else if (frame.t === 'unsub') {
      const ns = topicNamespace(conn.role, frame.c)
      if (ns) leaveChannel(conn, TOPIC + ns + ':' + frame.c)
    } else if (frame.t === 'sopen') await handleStoreOpen(conn, frame)
    else if (frame.t === 'srd') await handleStoreRead(conn, frame)
    else if (frame.t === 'swr') await handleStoreWrite(conn, frame)
    else if (frame.t === 'sclose') handleStoreClose(conn, frame)
    else if (frame.t === 'sres') {
      await handleClientReply(conn, frame.i, { ok: true, d: frame.d })
    } else if (frame.t === 'serr') {
      await handleClientReply(conn, frame.i, { ok: false, code: frame.code, m: frame.m, d: frame.d })
    } else if (frame.t === 'pong') {
      conn.lastPongAt = Date.now()
      conn.missedPongs = 0
    }
  }

  for (const transport of opts.transports) {
    void transport.start({ authenticate: authHook, onConnection: acceptConn })
  }

  function runMiddleware(info: MiddlewareInfo, terminal: () => Promise<void>): Promise<void> {
    const chain = opts.use ?? []
    let last = -1
    const dispatch = (idx: number): Promise<void> => {
      if (idx <= last) return Promise.reject(new Error('next() called multiple times'))
      last = idx
      const mw = chain[idx]
      if (!mw) return terminal()
      // middleware only runs for request/subscribe ops, which always carry a conn (bus events skip the chain)
      return Promise.resolve(mw(info.conn!.ctx as CtxUnion<A>, info, () => dispatch(idx + 1)))
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
      const e = err instanceof SuperLineError ? err : new SuperLineError('INTERNAL', 'Internal server error')
      if (!responded) conn.send({ t: 'err', i: id, code: e.code, m: e.message, d: e.data })
      if (inspectorEnabled && info.kind === 'request')
        emitInspectorEvent({
          type: 'msg.response',
          connId: conn.id,
          name: info.name,
          ok: false,
          error: { code: e.code, message: e.message },
        })
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
      if (inspectorEnabled)
        emitInspectorEvent({
          type: 'msg.request',
          connId: conn.id,
          role: conn.role,
          name: frame.m,
          input: safeSnapshot(input),
        })
      const output = await handler(input, conn.ctx, conn)
      if (inspectorEnabled)
        emitInspectorEvent({
          type: 'msg.response',
          connId: conn.id,
          name: frame.m,
          ok: true,
          output: safeSnapshot(output),
        })
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
        if (ok === false) throw new SuperLineError('FORBIDDEN', `Subscribe denied: ${frame.c}`)
      }
      await joinChannel(conn, TOPIC + ns + ':' + frame.c) // await adapter.subscribe so ready == active
      conn.send({ t: 'res', i: frame.i, d: null })
    })
  }

  // ---- Stores -------------------------------------------------------------
  // ACL is enforced here (core); the Store persists + decides the consistency model and never sees `principal`.
  // Fan-out reuses the channel machinery: subscribing a Resource joins `s:<name>:<id>`; a Change is published
  // to that channel and delivered to members by the generic adapter.onMessage path. Echo-break is client-side
  // (the client half skips its own `origin`), so no server-side origin-skip is needed.
  function storeOrErr(conn: Conn, id: number, name: string): ServerStore | undefined {
    const store = storeMap[name]
    if (!store) conn.send({ t: 'err', i: id, code: 'NOT_FOUND', m: `Unknown store: ${name}` })
    return store
  }

  async function handleStoreOpen(conn: Conn, frame: SOpenFrame): Promise<void> {
    const store = storeOrErr(conn, frame.i, frame.n)
    if (!store) return
    await dispatchOp(conn, frame.i, { kind: 'subscribe', name: `store:${frame.n}/${frame.id}`, conn }, async () => {
      const resource = await store.read(frame.id)
      if (!resource) throw new SuperLineError('NOT_FOUND', `No resource: ${frame.n}/${frame.id}`)
      const principal = conn.principal ?? conn.id
      if (!resource.accessRules[principal]?.read)
        throw new SuperLineError('FORBIDDEN', `Read denied: ${frame.n}/${frame.id}`)
      await joinChannel(conn, STORE + frame.n + ':' + frame.id)
      conn.send({ t: 'res', i: frame.i, d: resource.data }) // catch-up snapshot
    })
  }

  async function handleStoreRead(conn: Conn, frame: SReadFrame): Promise<void> {
    const store = storeOrErr(conn, frame.i, frame.n)
    if (!store) return
    await dispatchOp(conn, frame.i, { kind: 'request', name: `store:${frame.n}/${frame.id}`, conn }, async () => {
      const resource = await store.read(frame.id)
      if (!resource) throw new SuperLineError('NOT_FOUND', `No resource: ${frame.n}/${frame.id}`)
      const principal = conn.principal ?? conn.id
      if (!resource.accessRules[principal]?.read)
        throw new SuperLineError('FORBIDDEN', `Read denied: ${frame.n}/${frame.id}`)
      conn.send({ t: 'res', i: frame.i, d: resource.data })
    })
  }

  async function handleStoreWrite(conn: Conn, frame: SWriteFrame): Promise<void> {
    const store = storeOrErr(conn, frame.i, frame.n)
    if (!store) return
    await dispatchOp(conn, frame.i, { kind: 'request', name: `store:${frame.n}/${frame.id}`, conn }, async () => {
      const resource = await store.read(frame.id)
      if (!resource) throw new SuperLineError('NOT_FOUND', `No resource: ${frame.n}/${frame.id}`)
      const principal = conn.principal ?? conn.id
      if (!resource.accessRules[principal]?.write)
        throw new SuperLineError('FORBIDDEN', `Write denied: ${frame.n}/${frame.id}`)
      await store.apply({ id: frame.id, update: frame.u, origin: frame.o }) // → store.onChange → fan-out
      conn.send({ t: 'res', i: frame.i, d: null })
    })
  }

  function handleStoreClose(conn: Conn, frame: SCloseFrame): void {
    if (storeMap[frame.n]) leaveChannel(conn, STORE + frame.n + ':' + frame.id)
  }

  // Each Store's onChange is core's single fan-out source: publish the Change to the Resource channel,
  // delivered to subscribed conns by the generic adapter.onMessage path (loopback for the local node).
  for (const [name, store] of Object.entries(storeMap)) {
    store.onChange((change) => {
      void adapter.publish(
        STORE + name + ':' + change.id,
        serializer.encode({ t: 'sch', n: name, id: change.id, u: change.update, o: change.origin } satisfies SChangeFrame),
      )
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
        if (inspectorEnabled)
          emitInspectorEvent({ type: 'msg.broadcast', room: name, name: String(event), data: safeSnapshot(data) })
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
    const channel = TOPIC + ns + ':' + name
    if (inspectorEnabled) emitInspectorEvent({ type: 'msg.publish', topic: name, data: safeSnapshot(data) })
    // local echo: fire same-node bus subscribers in-process (no adapter round-trip), trusted (not re-validated)
    const busSet = busListeners.get(channel)
    if (busSet) for (const cb of busSet) callBus(cb, data, instanceId, name)
    void adapter.publish(channel, serializer.encode({ t: 'pub', c: name, d: data, i: instanceId } satisfies PubFrame))
  }

  function callBus(
    cb: (data: unknown, meta: BusMeta) => void,
    data: unknown,
    from: string,
    name: string,
  ): void {
    try {
      cb(data, { from }) // isolate each listener: one throw can't kill siblings or the message pump
    } catch (err) {
      opts.onError?.(err, { kind: 'event', name })
    }
  }

  // a bus frame from another node: validate the payload (inbound), then fan out to local subscribers
  function deliverBus(payload: string | Uint8Array, set: Set<(data: unknown, meta: BusMeta) => void>): void {
    let frame: PubFrame
    try {
      frame = serializer.decode(payload) as PubFrame
    } catch {
      return
    }
    if (frame.i === instanceId) return // own publish looped back; local listeners already fired directly
    const from = frame.i ?? ''
    const name = frame.c
    const def = c.shared?.serverToClient?.[name]
    const schema = def && typeof def === 'object' && 'payload' in def ? (def.payload as Schema) : undefined
    void (async () => {
      let data = frame.d
      if (schema) {
        try {
          data = await validate(schema, frame.d)
        } catch (err) {
          opts.onError?.(err, { kind: 'event', name })
          return
        }
      }
      for (const cb of set) callBus(cb, data, from, name)
    })()
  }

  // emit/close to a personal (c:/u:) channel; the owning node delivers via handlePersonal
  function personalTarget(channel: string): {
    emit: (event: string, data: unknown) => void
    close: () => void
  } {
    return {
      emit(event, data) {
        if (inspectorEnabled)
          emitInspectorEvent({
            type: 'msg.event',
            target: channel.slice(channel.indexOf(':') + 1),
            name: event,
            data: safeSnapshot(data),
          })
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
              reject(new SuperLineError('TIMEOUT', `Request '${name}' timed out`))
            }, ms)
          : undefined
      originWaiters.set(reqId, { resolve, reject, timer })
      opts?.signal?.addEventListener(
        'abort',
        () => {
          if (originWaiters.delete(reqId)) {
            if (timer) clearTimeout(timer)
            reject(new SuperLineError('BAD_REQUEST', 'Aborted'))
          }
        },
        { once: true },
      )
      if (inspectorEnabled)
        emitInspectorEvent({ type: 'msg.serverRequest', target: id, name, input: safeSnapshot(input) })
      const env: PersonalEnvelope = { p: 'req', o: instanceId, i: reqId, m: name, d: input }
      void adapter.publish(CONN + id, serializer.encode(env))
    })
  }

  // server-authoritative per-store handles: create/grant/revoke are server-only; write is the LWW co-write
  const storeApi: Record<string, ServerStoreHandle> = {}
  for (const [name, store] of Object.entries(storeMap)) {
    const readOrThrow = async (id: string): Promise<Resource> => {
      const r = await store.read(id)
      if (!r) throw new SuperLineError('NOT_FOUND', `No resource: ${name}/${id}`)
      return r
    }
    storeApi[name] = {
      async create(id, data, accessRules) {
        await store.create(id, data, accessRules)
      },
      read(id) {
        return Promise.resolve(store.read(id))
      },
      async write(id, data) {
        await store.apply({ id, update: data, origin: SERVER_ORIGIN })
      },
      async grant(id, principal, perms) {
        const r = await readOrThrow(id)
        await store.setAccess(id, { ...r.accessRules, [principal]: perms })
      },
      async revoke(id, principal) {
        const r = await readOrThrow(id)
        const next = { ...r.accessRules }
        delete next[principal]
        await store.setAccess(id, next)
      },
      async delete(id) {
        await store.delete(id)
      },
      list() {
        return Promise.resolve(store.list())
      },
    }
  }

  const api: SuperLineServer<C, A> = {
    nodeId: instanceId,
    nodeName,
    get local(): LocalView {
      return {
        connections: [...conns],
        get rooms() {
          return localRooms()
        },
        get topics() {
          return localTopics()
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
    subscribe(topic, handler) {
      const channel = TOPIC + 'shared:' + String(topic)
      let set = busListeners.get(channel)
      if (!set) {
        set = new Set()
        busListeners.set(channel, set)
        if (!members.has(channel)) void adapter.subscribe(channel) // first local member of either kind
      }
      const cb = handler as (data: unknown, meta: BusMeta) => void
      set.add(cb)
      return () => {
        const current = busListeners.get(channel)
        if (!current) return
        current.delete(cb)
        if (current.size === 0) {
          busListeners.delete(channel)
          if (!members.has(channel)) void adapter.unsubscribe(channel)
        }
      }
    },
    forRole(role) {
      return {
        publish(topic, data) {
          publishTo(role, String(topic), data)
        },
      }
    },
    store(name) {
      const handle = storeApi[name]
      if (!handle) throw new SuperLineError('NOT_FOUND', `Store not configured: ${name}`)
      return handle
    },
    async close() {
      if (closing) return
      closing = true
      if (hbTimer) clearInterval(hbTimer)
      for (const conn of conns) conn.close()
      for (const conn of inspectorConns) conn.close()
      await adapter.presence?.clearNode(instanceId) // remove this node's registry entries before disconnecting
      await adapter.close?.()
      for (const transport of opts.transports) await transport.stop()
    },
  }
  return api
}
