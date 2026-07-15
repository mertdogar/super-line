import {
  jsonSerializer,
  validate,
  SuperLineError,
  type Adapter,
  type Serializer,
  type Schema,
  type Contract,
  type Directional,
  type CtsOf,
  type CollectionDef,
  type CollectionName,
  type CrdtCollectionName,
  type RowOf,
  type DocOf,
  type CollectionStore,
  type CrdtCollectionStore,
  type InspectorEvent,
  type MessageError,
  type TapEvent,
  type ServerTransport,
  type RawConn,
  type Handshake,
  type AuthOutcome,
  type ReservedConnection,
  type ClientFrame,
  type ReqFrame,
  type EvtFrame,
  type PubFrame,
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
import { createCluster } from './cluster.js'
import { createCollectionRuntime, CDOC, COLL_CHANNEL } from './collections/index.js'
import type { CollectionPolicy, ServerCollectionHandle, CrdtCollectionPolicy, ServerCrdtCollectionHandle } from './collections/index.js'

export { Conn, resolvePrincipal } from './conn.js'
export { MemoryBus, createInMemoryAdapter } from './memory-adapter.js'
export { createCluster } from './cluster.js'
export { createCollectionRuntime } from './collections/index.js'
export type { Cluster, ClusterMessage } from './cluster.js'
export type {
  CollectionConn,
  CollectionHost,
  CollectionPolicy,
  CollectionRuntime,
  CollectionRuntimeConfig,
  ServerCollectionHandle,
  WriteOp,
  CrdtCollectionPolicy,
  ServerCrdtCollectionHandle,
} from './collections/index.js'

// Web Crypto UUID — available in every browser and Node 19+. Keeps the server
// runnable in-browser (e.g. a loopback-transport demo) with no node:crypto import.
const randomUUID = (): string => globalThis.crypto.randomUUID()

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
const PLUGIN = 'x:' // reserved prefix for plugin-private channels: `x:<plugin>:<name>`
// `d:` (per-document fan-out) and `cbatch` (relayed row batches) belong to the Collection runtime, which is
// their only user — see ./collections. They are imported here purely so the adapter demux can route to it.

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
  /**
   * The operation kind. Middleware only ever sees `'request'`/`'subscribe'`; `'event'` marks a bus
   * event delivery, and `'connect'`/`'disconnect'` mark a lifecycle-hook throw routed to `onError`.
   */
  kind: 'request' | 'subscribe' | 'event' | 'connect' | 'disconnect'
  /** The request/topic/event name (the hook name for lifecycle errors). */
  name: string
  /** The connection the operation is on, if any (`conn.role` available). Absent for bus events. */
  conn?: Conn
}

/**
 * A plugin's flat middleware — like {@link Middleware} but `ctx` is `unknown` (a plugin is written
 * independently of the host's per-role ctx). Concatenated after the host chain, in plugin array order.
 */
export type PluginMiddleware = (
  ctx: unknown,
  info: MiddlewareInfo,
  next: () => Promise<void>,
) => Awaitable<void>

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
 * Handlers a plugin provides for its paired surface `S` (ADR-0004): one per `clientToServer` key,
 * typed from `S`. `ctx`/`conn` are loose — a plugin is written independently of the host's per-role ctx.
 */
export type HandlersFor<S extends Directional> = {
  [K in keyof CtsOf<S>]: (
    input: ServerInput<CtsOf<S>[K]>,
    ctx: unknown,
    conn: Conn,
  ) => Awaitable<Output<CtsOf<S>[K]>>
}

/** Keys one plugin handles; a naked param so a multi-plugin `P[number]` union distributes per-plugin. */
type PluginHandledKeys<U> = U extends SuperLinePlugin<infer S> ? keyof CtsOf<S> & string : never
/** Union of the `clientToServer` keys handled across a plugin tuple `P` (subtracted from `implement`). */
export type HandledKeys<P extends readonly SuperLinePlugin<any>[]> = PluginHandledKeys<P[number]>

/**
 * Remove the plugin-handled keys `HK` from every block (each role + `shared`) of a {@link Handlers} map. A block
 * a plugin fully owns collapses to `{}` and becomes OPTIONAL — so a host needn't pass an empty `shared: {}` /
 * `guest: {}` for a role or shared surface a plugin handles entirely.
 */
export type SubtractHandlers<H, HK extends string> = {
  [B in keyof H as [keyof Omit<H[B], HK>] extends [never] ? never : B]: Omit<H[B], HK>
} & {
  [B in keyof H as [keyof Omit<H[B], HK>] extends [never] ? B : never]?: Omit<H[B], HK>
}

/**
 * A named, declarative bundle of runtime contributions registered on `plugins: [...]`. All fields
 * are optional; a plugin ships as a pair (this server half + an optional client half). See ADR-0005.
 * The optional type param `S` is the plugin's paired surface — its `handlers` compile against `S`, and
 * `S`'s `clientToServer` keys are subtracted from the host's `implement()` obligation at compile time.
 */
export interface SuperLinePlugin<S extends Directional = {}> {
  /** Unique among the server's plugins; a duplicate name throws at construction. */
  name: string
  /**
   * Node-local tap fired synchronously at each emit site with LIVE payload references (an observer
   * must not mutate them). Reuses the {@link TapEvent} taxonomy; zero cost when no plugin taps. A
   * throwing tap is isolated and routed to `onError` — it never fails the underlying operation.
   */
  onEvent?: (event: TapEvent) => void
  /** Middleware run before request/subscribe handlers, after the host chain, in plugin array order. */
  use?: PluginMiddleware[]
  /** Called once per accepted connection (multiplexed after the host's `onConnection`). */
  onConnection?: (conn: Conn, ctx: unknown) => void
  /** Called when a connection closes (multiplexed after the host's `onDisconnect`). */
  onDisconnect?: (conn: Conn, ctx: unknown, code: number) => void
  /** Receives any error thrown in middleware/handlers/hooks (multiplexed with the host's `onError`). */
  onError?: (error: unknown, info: MiddlewareInfo) => void
  /**
   * Request handlers for the plugin's paired surface `S`, built lazily with the {@link PluginContext}.
   * Merged into dispatch under their method names; the host merges `S` into a role and these keys are
   * subtracted from its `implement()` obligation. A key already handled by the host (or another plugin)
   * throws at construction.
   */
  handlers?: (ctx: PluginContext) => HandlersFor<S>
  /**
   * Row-security policies for the collections the plugin's contract fragment declares (see {@link CollectionPolicy}).
   * Merged into the host's `policies`; a collection already policied by the host or another plugin throws at
   * construction, and a policy for a collection no fragment declared throws too. Deny-by-default still holds —
   * a collection nobody policies is server-only. Lets a plugin ship its collections locked down (e.g. deny-all
   * on secret tables) without the host hand-spreading them.
   */
  policies?: Record<string, CollectionPolicy<unknown, unknown>>
  /**
   * A plugin-owned (reserved) connection class — its own role, handshake negotiation, and parallel contract,
   * served over observer-invisible connections. See {@link PluginConnection}. (Phase 2.)
   */
  connection?: PluginConnection
  /**
   * Imperative escape hatch, run once at construction with the plugin's {@link PluginContext}. Return
   * an optional dispose function, called on `server.close()`. Use for wiring cluster-wide views from
   * local taps + a plugin channel (the inspector's pattern), timers, or background subscriptions.
   */
  setup?: (ctx: PluginContext) => void | (() => void)
}

/**
 * A plugin-owned connection class (ADR-0005 phase 2): a reserved role the transport negotiates (never one
 * of the user contract's roles), dispatched against the plugin's own fixed `contract` — never merged into
 * the user's. Matching conns are observer-invisible (excluded from conns/presence/heartbeat/user hooks).
 * The inspector's Control-Center channel is one such class.
 */
export interface PluginConnection {
  /** The reserved role; must be unique across the server (user roles + other reserved classes). */
  role: string
  /** WebSocket subprotocol to advertise + match (browsers set this where they can't set headers). */
  subprotocol?: string
  /** Predicate for transports without a subprotocol (SSE/libp2p): match on the normalized handshake. */
  match?: (handshake: Handshake) => boolean
  /** The parallel contract these connections speak (its `clientToServer` = requests, `subscribe` topics = feeds). */
  contract: Contract
  /**
   * Request handlers for `contract`'s `clientToServer`, built with the {@link PluginContext}. A subscribe to
   * one of `contract`'s topics bridges the conn to the plugin's {@link PluginChannel} of the same name.
   */
  handlers?: (ctx: PluginContext) => Record<string, (input: unknown, conn: Conn) => Awaitable<unknown>>
}

/** A plugin-private adapter channel (reserved `x:<plugin>:` prefix), fanned out cluster-wide. */
export interface PluginChannel {
  /** Publish to this channel; delivered to every node's subscribers (local echo included). */
  publish(data: unknown): void
  /** Subscribe to this channel. `meta.from` is the publishing node. Returns an unsubscribe fn. */
  subscribe(handler: (data: unknown, meta: BusMeta) => void): () => void
}

/**
 * The capabilities handed to a plugin's `setup`/`handlers`: the server's public surface minus the
 * footguns (`implement`/`close`), plus a privileged block — a plugin-private adapter {@link PluginChannel},
 * node identity, the serializer, a read-only conns view, and the raw contract for reflection. Sized to
 * the inspector's audited needs; grows case-by-case.
 */
export interface PluginContext {
  /** This node's stable id (equals `srv.nodeId`). */
  readonly nodeId: string
  /** This node's friendly name (equals `srv.nodeName`). */
  readonly nodeName: string
  /** Alias of {@link PluginContext.nodeId} — the per-process instance id used to tag cluster fan-out. */
  readonly instanceId: string
  /** The wire serializer configured on the server. */
  readonly serializer: Serializer
  /** The raw contract, for reflection (e.g. `classifyContract`). */
  readonly contract: Contract
  /** Connections accepted on THIS node (read-only snapshot; excludes reserved conns). */
  readonly conns: readonly Conn[]
  /** Node-local introspection (connections, rooms, topics on this process). */
  readonly local: LocalView
  /** Cluster-wide presence introspection (rejects without a presence-capable adapter). */
  readonly cluster: ClusterView
  /** Whether a user (by `identify` key) has at least one live connection anywhere. */
  isOnline(userId: string): Promise<boolean>
  /** Publish a shared topic (server-only publish). */
  publish(topic: string, data: unknown): void
  /** Subscribe server-side to a shared topic, cluster-wide (local echo). Returns an unsubscribe fn. */
  subscribe(topic: string, handler: (data: unknown, meta: BusMeta) => void): () => void
  /** Target a single connection by id, on whatever node holds it. */
  toConn(id: string): { emit(event: string, data: unknown): void; close(): void }
  /** Target all of a user's connections across nodes. */
  toUser(userId: string): { emit(event: string, data: unknown): void; disconnect(): void }
  /** Server-controlled room membership + broadcast (loosely typed, mirroring toConn/toUser). */
  room(name: string): {
    add(conn: Conn): void
    remove(conn: Conn): void
    broadcast(event: string, data: unknown): void
    readonly size: number
    readonly connections: readonly Conn[]
  }
  /** Server-authoritative handle for a contract collection (loosely typed here as the LWW row handle — the surface plugins/inspector use); throws if none is configured. */
  collection(name: string): ServerCollectionHandle
  /** Declared collections (name + key + advisory references) for the schema graph. */
  collectionInfos(): { name: string; key: string; references: Record<string, string> }[]
  /** Full cluster descriptor for a local connection (identity + rooms + `describeConn` extras). */
  describe(conn: Conn): ConnDescriptor
  /** A connection's descriptor anywhere in the cluster (rejects without presence support); undefined if absent. */
  connectionById(id: string): Promise<ConnDescriptor | undefined>
  /** A plugin-private, cluster-wide adapter channel under the reserved `x:<plugin>:` prefix. */
  channel(name: string): PluginChannel
}

/** Options for {@link createSuperLineServer}. */
export interface SuperLineServerOptions<
  C extends Contract,
  A extends AuthResult<C>,
  P extends readonly SuperLinePlugin<any>[] = readonly SuperLinePlugin<any>[],
> {
  /** Named runtime bundles (taps, middleware, lifecycle, handlers, stores). See {@link SuperLinePlugin}. */
  plugins?: P
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
   * The single {@link CollectionStore} backend serving every collection this contract declares (typed rows;
   * ADR-0006), e.g. `collections: memoryCollections()`. One backend ⇒ one transaction domain, so a
   * cross-collection batch commits atomically.
   */
  collections?: CollectionStore
  /**
   * The {@link CrdtCollectionStore} backend serving this contract's CRDT document collections (ADR-0007),
   * e.g. `crdtCollections: crdtMemoryCollections()`. A backend per family: CRDT docs never join a
   * cross-collection atomic batch, so they get their own backend, separate from `collections`.
   */
  crdtCollections?: CrdtCollectionStore
  /**
   * Access policies per collection. Deny-by-default: a collection with no policy is server-only. LWW row
   * collections take an RLS-style {@link CollectionPolicy} (read → filter); CRDT document collections take a
   * guard-shaped {@link CrdtCollectionPolicy} (read → bool). Server co-writes via `srv.collection(n)` bypass them.
   */
  policies?: {
    [N in CollectionName<C>]?: N extends CrdtCollectionName<C>
      ? CrdtCollectionPolicy<CtxUnion<A>, DocOf<C, N>>
      : CollectionPolicy<CtxUnion<A>, RowOf<C, N>>
  }
  /**
   * Opt-in advisory foreign-key checks (see ADR-0006, decision 8). When true, an insert/update whose
   * `references` field points at a non-existent row is rejected at the accepting node. Best-effort under
   * relay clustering (no global serialization point) and does NOT resolve intra-batch parent-then-child
   * references; there are no cascades. Off by default.
   */
  checkReferences?: boolean
  /** Called once per accepted connection. */
  onConnection?: (conn: Conn, ctx: CtxUnion<A>) => void
  /** Called when a connection closes, with the WebSocket close `code`. */
  onDisconnect?: (conn: Conn, ctx: CtxUnion<A>, code: number) => void
  /** Called for any error thrown in middleware/handlers (after the client is replied to). */
  onError?: (error: unknown, info: MiddlewareInfo) => void
}

/** A running super-line server, returned by {@link createSuperLineServer}. */
export interface SuperLineServer<C extends Contract, A extends AuthResult<C>, HK extends string = never> {
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
  /** Register handlers for shared + per-role requests (chainable). Keys handled by a plugin (`HK`) are subtracted. */
  implement(handlers: SubtractHandlers<Handlers<C, A>, HK>): SuperLineServer<C, A, HK>
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
  /**
   * Server-authoritative handle for a contract collection, typed by the contract: an LWW row collection gives
   * `ServerCollectionHandle` (`insert`/`update`/`batch`), a CRDT document collection gives
   * `ServerCrdtCollectionHandle` (`create`/`open`). Throws `NOT_FOUND` if no matching backend is configured
   * or the name isn't declared.
   */
  collection<N extends CollectionName<C>>(
    name: N,
  ): N extends CrdtCollectionName<C> ? ServerCrdtCollectionHandle<DocOf<C, N>> : ServerCollectionHandle<RowOf<C, N>>
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
export function createSuperLineServer<
  C extends Contract,
  A extends AuthResult<C>,
  const P extends readonly SuperLinePlugin<any>[] = [],
>(contract: C, opts: SuperLineServerOptions<C, A, P>): SuperLineServer<C, A, HandledKeys<P>> {
  const c: Contract = contract
  const serializer = opts.serializer ?? jsonSerializer
  const adapter = opts.adapter ?? createInMemoryAdapter()
  const plugins = opts.plugins ?? []
  const pluginNames = new Set<string>()
  for (const p of plugins) {
    if (pluginNames.has(p.name)) throw new Error(`Duplicate plugin name: ${p.name}`)
    pluginNames.add(p.name)
  }

  // ---- Collections: contract-declared defs + the host's and plugins' policies ----
  const collectionDefs = (c.collections ?? {}) as Record<string, CollectionDef>
  const collectionPolicies = { ...opts.policies } as Record<string, unknown>
  // merge plugin-contributed row policies; unknown-collection or collision with host/another plugin throws
  for (const p of plugins) {
    if (!p.policies) continue
    for (const [name, policy] of Object.entries(p.policies)) {
      if (!(name in collectionDefs))
        throw new Error(
          `Plugin '${p.name}' policy references unknown collection '${name}' — register its contract fragment on defineContract({ plugins })`,
        )
      if (name in collectionPolicies)
        throw new Error(`Plugin '${p.name}' policy for collection '${name}' collides with an existing policy`)
      collectionPolicies[name] = policy
    }
  }

  // Reserved (plugin-owned) connection classes declared to transports; matching conns are observer-invisible.
  const reserved: ReservedConnection[] = []
  for (const p of plugins) {
    if (!p.connection) continue
    const { role, subprotocol, match } = p.connection
    if (reserved.some((r) => r.role === role) || role in c.roles)
      throw new Error(`Plugin '${p.name}' reserved role '${role}' collides with an existing role`)
    reserved.push({ role, subprotocol, match })
  }
  const reservedRoles = new Set(reserved.map((r) => r.role))
  // serving side (handlers + parallel contract + ctx), populated after `api` is built
  const reservedServing = new Map<
    string,
    { connection: PluginConnection; handlers: Record<string, (input: unknown, conn: Conn) => Awaitable<unknown>>; ctx: PluginContext }
  >()

  // Lifecycle + error fan-out: host hook first, then each plugin's, error-isolated per listener.
  const errorHandlers: Array<(error: unknown, info: MiddlewareInfo) => void> = []
  if (opts.onError) errorHandlers.push(opts.onError)
  for (const p of plugins) if (p.onError) errorHandlers.push(p.onError)
  function fireError(error: unknown, info: MiddlewareInfo): void {
    for (const handler of errorHandlers) {
      try {
        handler(error, info)
      } catch {
        // an error handler that itself throws has nowhere left to route — swallow
      }
    }
  }

  const connectionHooks: Array<(conn: Conn, ctx: unknown) => void> = []
  if (opts.onConnection) connectionHooks.push(opts.onConnection as (conn: Conn, ctx: unknown) => void)
  for (const p of plugins) if (p.onConnection) connectionHooks.push(p.onConnection)
  function fireConnection(conn: Conn, ctx: unknown): void {
    for (const handler of connectionHooks) {
      try {
        handler(conn, ctx)
      } catch (err) {
        fireError(err, { kind: 'connect', name: 'onConnection', conn })
      }
    }
  }

  const disconnectHooks: Array<(conn: Conn, ctx: unknown, code: number) => void> = []
  if (opts.onDisconnect) disconnectHooks.push(opts.onDisconnect as (conn: Conn, ctx: unknown, code: number) => void)
  for (const p of plugins) if (p.onDisconnect) disconnectHooks.push(p.onDisconnect)
  function fireDisconnect(conn: Conn, ctx: unknown, code: number): void {
    for (const handler of disconnectHooks) {
      try {
        handler(conn, ctx, code)
      } catch (err) {
        fireError(err, { kind: 'disconnect', name: 'onDisconnect', conn })
      }
    }
  }

  // Combined middleware chain: host `use` first, then each plugin's `use` in array order.
  const middlewareChain: Middleware<A>[] = [
    ...(opts.use ?? []),
    ...plugins.flatMap((p) => (p.use ?? []) as Middleware<A>[]),
  ]

  const conns = new Set<Conn>()
  const reservedConns = new Set<Conn>() // plugin-owned conns: kept out of conns/presence/heartbeat/user hooks
  // local members per namespaced channel (rooms + topics share this registry)
  const members = new Map<string, Set<Conn>>()
  // server-side bus subscribers per topic channel (parallel to `members` which holds conns)
  const busListeners = new Map<string, Set<(data: unknown, meta: BusMeta) => void>>()
  // plugin-private channels (x:<plugin>:<name>), off-contract so they don't ride the validated bus path
  const pluginChannels = new Map<string, Set<(data: unknown, meta: BusMeta) => void>>()
  const instanceId = randomUUID() // identifies this node; lets the bus drop its own looped-back echo
  // owns node identity on the wire: stamps `nd` outbound, reports `own` inbound. Detection only — each caller
  // still picks its own delivery policy (see the Cluster docs: deliver-at-source vs deliver-on-receipt).
  const cluster = createCluster(adapter, serializer, instanceId)
  const envNodeName = typeof process !== 'undefined' ? process.env.SUPER_LINE_NODE_NAME : undefined
  const nodeName = opts.nodeName ?? envNodeName ?? instanceId.slice(0, 8)
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
    if (channel.startsWith(CDOC)) {
      collections.onCrdtRelay(channel, payload)
      return
    }
    if (channel === COLL_CHANNEL) {
      collections.onRelay(payload)
      return
    }
    if (channel.startsWith(PLUGIN)) {
      handlePluginChannel(channel, payload)
      return
    }
    const set = members.get(channel)
    if (set) for (const conn of set) conn.sendRaw(payload)
    const busSet = busListeners.get(channel)
    if (busSet) deliverBus(payload, busSet)
  })

  // the server→client request feature subscribes its reply channel up front (one per node)
  void adapter.subscribe(replyChannel)
  // (the Collection runtime subscribes COLL_CHANNEL itself, once it exists — see below)

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
    if (taps.length)
      emitTap(
        env.ok
          ? { type: 'msg.serverReply', target: conn.id, name: r.name, ok: true, output: env.d, reqId: r.corrId }
          : {
              type: 'msg.serverReply',
              target: conn.id,
              name: r.name,
              ok: false,
              error: { code: env.code, message: env.m },
              reqId: r.corrId,
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

  // Multi-consumer tap: every emit site funnels here. Consumers receive LIVE payload refs, in
  // registration order (the inspector first, then plugin `onEvent` taps). A throwing consumer is
  // isolated + routed to onError so a bad tap can't fail the underlying op. Zero cost when empty.
  const taps: Array<(event: InspectorEvent) => void> = []
  function emitTap(event: InspectorEvent): void {
    if (!taps.length) return
    for (const tap of taps) {
      try {
        tap(event)
      } catch (err) {
        fireError(err, { kind: 'event', name: event.type })
      }
    }
  }

  for (const p of plugins) if (p.onEvent) taps.push(p.onEvent) // taps: plugin observers (the inspector is one)

  function joinChannel(conn: Conn, channel: string): void | Promise<void> {
    conn.channels.add(channel)
    if (channel.startsWith(ROOM)) {
      const room = channel.slice(ROOM.length)
      void adapter.presence?.addRoom(conn.id, room)
      emitTap({ type: 'room.add', connId: conn.id, room })
    } else if (channel.startsWith(TOPIC)) {
      emitTap({ type: 'topic.sub', connId: conn.id, topic: channel.slice(channel.indexOf(':', TOPIC.length) + 1) })
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
      emitTap({ type: 'room.remove', connId: conn.id, room })
    } else if (channel.startsWith(TOPIC)) {
      emitTap({ type: 'topic.unsub', connId: conn.id, topic: channel.slice(channel.indexOf(':', TOPIC.length) + 1) })
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

  // Serve a plugin-owned reserved connection: dispatch req against its parallel-contract handlers, and
  // bridge a topic subscribe to the plugin's channel of the same name (so the plugin's publishes reach it).
  const reservedBridges = new WeakMap<Conn, Map<string, () => void>>()
  async function onReservedFrame(conn: Conn, frame: ClientFrame): Promise<void> {
    const serving = reservedServing.get(conn.role)
    if (!serving) return
    if (frame.t === 'req') {
      const handler = serving.handlers[frame.m]
      if (!handler) {
        conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown message: ${frame.m}` })
        return
      }
      try {
        conn.send({ t: 'res', i: frame.i, d: await handler(frame.d, conn) })
      } catch (err) {
        const e = err instanceof SuperLineError ? err : new SuperLineError('INTERNAL', 'Internal server error')
        conn.send({ t: 'err', i: frame.i, code: e.code, m: e.message, d: e.data })
      }
    } else if (frame.t === 'sub') {
      if (!isSubscribeTopic(serving.connection.contract, frame.c)) {
        conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown topic: ${frame.c}` })
        return
      }
      let bridges = reservedBridges.get(conn)
      if (!bridges) {
        bridges = new Map()
        reservedBridges.set(conn, bridges)
      }
      bridges.get(frame.c)?.() // drop a prior subscription to the same topic
      bridges.set(frame.c, serving.ctx.channel(frame.c).subscribe((data) => conn.send({ t: 'pub', c: frame.c, d: data })))
      conn.send({ t: 'res', i: frame.i, d: null })
    } else if (frame.t === 'unsub') {
      const bridges = reservedBridges.get(conn)
      bridges?.get(frame.c)?.()
      bridges?.delete(frame.c)
    }
  }

  function isSubscribeTopic(contract: Contract, name: string): boolean {
    const isTopicDef = (def: unknown): boolean =>
      !!def && typeof def === 'object' && 'subscribe' in def && (def as { subscribe?: unknown }).subscribe === true
    if (isTopicDef(contract.shared?.serverToClient?.[name])) return true
    for (const role of Object.keys(contract.roles)) if (isTopicDef(contract.roles[role]?.serverToClient?.[name])) return true
    return false
  }

  // Core owns the auth decision; each transport calls this at its native moment and rejects natively on throw.
  const authHook = async (handshake: Handshake): Promise<AuthOutcome> => {
    const auth = await opts.authenticate(handshake)
    return { role: auth.role, ctx: auth.ctx, transport: handshake.transport }
  }

  // A transport accepted (and authenticated) a connection — wire it up. Reserved conns (a role the server
  // declared in `reserved`, set by the transport) are observer-invisible and dispatch against a parallel contract.
  function acceptConn(raw: RawConn, auth: AuthOutcome): void {
    const role = auth.role
    const ctx = auth.ctx
    const isReserved = reservedRoles.has(role) // a plugin-declared reserved role (e.g. the inspector's)
    const connId = randomUUID()
    const conn = new Conn(
      raw,
      connId,
      role,
      ctx,
      serializer,
      taps.length
        ? (event, data) => emitTap({ type: 'msg.event', target: connId, name: event, data })
        : undefined,
    )
    conn.transport = auth.transport
    conn.principal = resolvePrincipal(conn, opts.identify) // ACL identity for stores; always defined
    raw.onMessage((bytes) => {
      void onMessage(conn, bytes)
    })

    if (isReserved) {
      // observer-invisible: not in conns/presence/heartbeat, no lifecycle hooks
      reservedConns.add(conn)
      raw.onClose(() => {
        reservedConns.delete(conn)
        const bridges = reservedBridges.get(conn) // plugin-owned conns bridge topics to plugin channels
        if (bridges) {
          for (const off of bridges.values()) off()
          reservedBridges.delete(conn)
        }
        for (const channel of conn.channels) leaveChannel(conn, channel) // inline inspector's i:events sub
      })
      return
    }

    conns.add(conn)
    raw.onClose((code) => {
      conns.delete(conn)
      for (const channel of conn.channels) leaveChannel(conn, channel)
      collections.detach(conn) // drop this conn's collection subscriptions from the routing registry
      void adapter.presence?.del(conn.id)
      const goneUserId = opts.identify?.(conn) // carry the name so the feed can label a purged conn
      emitTap({
        type: 'disconnect',
        connId: conn.id,
        nodeId: instanceId,
        ...(goneUserId !== undefined ? { userId: goneUserId } : {}),
      })
      fireDisconnect(conn, ctx, code)
    })
    fireConnection(conn, ctx) // may seed conn.data before the snapshot
    const descriptor = buildDescriptor(conn) // snapshot (reads conn.data)
    void adapter.presence?.set(descriptor)
    emitTap({ type: 'connect', descriptor })
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
    if (reservedConns.has(conn)) {
      await onReservedFrame(conn, frame) // dispatch against the plugin's parallel contract
      return
    }
    if (frame.t === 'req') await handleReq(conn, frame)
    else if (frame.t === 'sub') await handleSub(conn, frame)
    else if (frame.t === 'unsub') {
      const ns = topicNamespace(conn.role, frame.c)
      if (ns) leaveChannel(conn, TOPIC + ns + ':' + frame.c)
    } else if (frame.t === 'csub') await collections.onSub(conn, frame)
    else if (frame.t === 'cuns') collections.onUnsub(conn, frame)
    else if (frame.t === 'cbat') await collections.onBatch(conn, frame)
    else if (frame.t === 'cdopen') await collections.onCrdtOpen(conn, frame)
    else if (frame.t === 'cdwr') await collections.onCrdtWrite(conn, frame)
    else if (frame.t === 'cdclose') collections.onCrdtClose(conn, frame)
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
    void transport.start({ authenticate: authHook, onConnection: acceptConn, reserved })
  }

  function runMiddleware(info: MiddlewareInfo, terminal: () => Promise<void>): Promise<void> {
    const chain = middlewareChain
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
    // Collection/CRDT ops pass their own dedicated error tap here; it replaces the generic `msg.response`.
    onError?: (error: MessageError) => void,
  ): Promise<void> {
    let responded = false
    try {
      await runMiddleware(info, async () => {
        await terminal()
        responded = true
      })
    } catch (err) {
      fireError(err, info)
      const e = err instanceof SuperLineError ? err : new SuperLineError('INTERNAL', 'Internal server error')
      if (!responded) conn.send({ t: 'err', i: id, code: e.code, m: e.message, d: e.data })
      if (!taps.length) return
      if (onError) onError({ code: e.code, message: e.message })
      else if (info.kind === 'request')
        emitTap({
          type: 'msg.response',
          connId: conn.id,
          name: info.name,
          ok: false,
          error: { code: e.code, message: e.message },
          reqId: id,
        })
    }
  }

  async function handleReq(conn: Conn, frame: ReqFrame): Promise<void> {
    // resolving by role inherently enforces the boundary: a cross-role method is unknown here. The `def`
    // lookup gates the plugin-handler fallback too, so a plugin handler only fires for a method in this role.
    const def = c.roles[conn.role]?.clientToServer?.[frame.m] ?? c.shared?.clientToServer?.[frame.m]
    const handler = impl[conn.role]?.[frame.m] ?? impl.shared?.[frame.m] ?? pluginHandlers[frame.m]
    if (!def || !handler) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown message: ${frame.m}` })
      return
    }
    await dispatchOp(conn, frame.i, { kind: 'request', name: frame.m, conn }, async () => {
      const input = await validate(def.input, frame.d)
      if (taps.length)
        emitTap({
          type: 'msg.request',
          connId: conn.id,
          role: conn.role,
          name: frame.m,
          input,
          reqId: frame.i,
        })
      const output = await handler(input, conn.ctx, conn)
      if (taps.length)
        emitTap({
          type: 'msg.response',
          connId: conn.id,
          name: frame.m,
          ok: true,
          output,
          reqId: frame.i,
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

  // ---- Collections ---------------------------------------------------------------------------------------
  // The Collection runtime (ADR-0006 rows + ADR-0007 CRDT documents) lives behind ./collections. The server
  // hands it frames, relayed payloads, and departing conns; it hands back `srv.collection(n)` and the shapes
  // the inspector reports. Everything it needs is below, as capabilities rather than raw handles.
  const collections = createCollectionRuntime(
    {
      store: opts.collections,
      crdtStore: opts.crdtCollections,
      defs: collectionDefs,
      policies: collectionPolicies,
      checkReferences: opts.checkReferences ?? false,
    },
    {
      dispatch: (conn, id, info, terminal, onError) =>
        dispatchOp(conn as Conn, id, { ...info, conn: info.conn as Conn }, terminal, onError),
      cluster,
      channels: {
        join: (conn, channel) => joinChannel(conn as Conn, channel),
        leave: (conn, channel) => leaveChannel(conn as Conn, channel),
        membersOf: (channel) => members.get(channel),
      },
      // lazy on purpose: with nothing tapping, the payload is never built and collections never learn that
      // observation has a cost. The closure keeps `emitTap` for its own sites; this adapts, it doesn't mirror.
      tap: (event) => {
        if (taps.length) emitTap(event())
      },
      encode: (frame) => serializer.encode(frame),
    },
  )
  // a relay-mode row backend needs every node to receive every batch (any node may hold subscribers)
  if (collections.relaysRows) void adapter.subscribe(COLL_CHANNEL)

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
        if (taps.length)
          emitTap({ type: 'msg.broadcast', room: name, name: String(event), data })
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
    if (taps.length) emitTap({ type: 'msg.publish', topic: name, data })
    // local echo: fire same-node bus subscribers in-process (no adapter round-trip), trusted (not re-validated)
    const busSet = busListeners.get(channel)
    if (busSet) for (const cb of busSet) callBus(cb, data, instanceId, name)
    cluster.broadcast(channel, { t: 'pub', c: name, d: data } satisfies Omit<PubFrame, 'nd'>)
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
      fireError(err, { kind: 'event', name })
    }
  }

  // a bus frame from another node: validate the payload (inbound), then fan out to local subscribers
  function deliverBus(payload: string | Uint8Array, set: Set<(data: unknown, meta: BusMeta) => void>): void {
    const msg = cluster.receive(payload)
    if (!msg) return
    if (msg.own) return // deliver-at-source: local listeners already fired directly in publishTo
    const frame = msg.data as PubFrame
    const from = msg.from
    const name = frame.c
    const def = c.shared?.serverToClient?.[name]
    const schema = def && typeof def === 'object' && 'payload' in def ? (def.payload as Schema) : undefined
    void (async () => {
      let data = frame.d
      if (schema) {
        try {
          data = await validate(schema, frame.d)
        } catch (err) {
          fireError(err, { kind: 'event', name })
          return
        }
      }
      for (const cb of set) callBus(cb, data, from, name)
    })()
  }

  // a frame on a plugin channel (x:<plugin>:<name>): decode the {d} envelope, drop our own echo, deliver.
  function handlePluginChannel(channel: string, payload: string | Uint8Array): void {
    const set = pluginChannels.get(channel)
    if (!set) return
    const msg = cluster.receive(payload)
    if (!msg) return
    if (msg.own) return // deliver-at-source: local listeners already fired directly in pluginChannel.publish
    for (const cb of set) callBus(cb, (msg.data as { d: unknown }).d, msg.from, channel)
  }

  // a plugin-private, cluster-wide channel: local echo in-process + adapter fan-out, own echo dropped by id.
  function pluginChannel(pluginName: string, name: string): PluginChannel {
    const channel = PLUGIN + pluginName + ':' + name
    return {
      publish(data) {
        const set = pluginChannels.get(channel)
        if (set) for (const cb of set) callBus(cb, data, instanceId, channel) // local echo
        cluster.broadcast(channel, { d: data })
      },
      subscribe(handler) {
        let set = pluginChannels.get(channel)
        if (!set) {
          set = new Set()
          pluginChannels.set(channel, set)
          void adapter.subscribe(channel)
        }
        set.add(handler)
        return () => {
          const current = pluginChannels.get(channel)
          if (!current) return
          current.delete(handler)
          if (current.size === 0) {
            pluginChannels.delete(channel)
            void adapter.unsubscribe(channel)
          }
        }
      },
    }
  }

  // emit/close to a personal (c:/u:) channel; the owning node delivers via handlePersonal
  function personalTarget(channel: string): {
    emit: (event: string, data: unknown) => void
    close: () => void
  } {
    return {
      emit(event, data) {
        if (taps.length)
          emitTap({
            type: 'msg.event',
            target: channel.slice(channel.indexOf(':') + 1),
            name: event,
            data,
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
      if (taps.length)
        emitTap({ type: 'msg.serverRequest', target: id, name, input, reqId })
      const env: PersonalEnvelope = { p: 'req', o: instanceId, i: reqId, m: name, d: input }
      void adapter.publish(CONN + id, serializer.encode(env))
    })
  }

  const pluginDisposers: Array<() => void> = [] // populated after `api` is built (plugin setup() returns)
  const pluginHandlers: Record<string, AnyHandler> = {} // plugin request handlers, keyed by method name

  const api: SuperLineServer<C, A, HandledKeys<P>> = {
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
      const map = handlers as unknown as Impl
      // Runtime floor (ships regardless of the compile-time subtraction): every contract clientToServer
      // key must be covered by exactly one of the impl map or a plugin — never both, never neither.
      const missing: string[] = []
      const duplicate: string[] = []
      const checkBlock = (block: string, defs: Record<string, unknown> | undefined): void => {
        if (!defs) return
        for (const key of Object.keys(defs)) {
          const inImpl = !!map[block]?.[key]
          const inPlugin = key in pluginHandlers
          if (inImpl && inPlugin) duplicate.push(`${block}.${key}`)
          else if (!inImpl && !inPlugin) missing.push(`${block}.${key}`)
        }
      }
      checkBlock('shared', c.shared?.clientToServer)
      for (const role of Object.keys(c.roles)) checkBlock(role, c.roles[role]?.clientToServer)
      if (duplicate.length)
        throw new Error(`implement: these keys are also handled by a plugin — remove them: ${duplicate.join(', ')}`)
      if (missing.length) throw new Error(`implement: missing handler(s) for: ${missing.join(', ')}`)
      impl = map
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
    collection<N extends CollectionName<C>>(
      name: N,
    ): N extends CrdtCollectionName<C> ? ServerCrdtCollectionHandle<DocOf<C, N>> : ServerCollectionHandle<RowOf<C, N>> {
      type Ret = N extends CrdtCollectionName<C> ? ServerCrdtCollectionHandle<DocOf<C, N>> : ServerCollectionHandle<RowOf<C, N>>
      return collections.handle(name) as Ret
    },
    async close() {
      if (closing) return
      closing = true
      for (const dispose of pluginDisposers) {
        try {
          dispose() // plugins tear down first, while the adapter is still live for channel unsubscribes
        } catch {
          // a dispose that throws can't block the rest of shutdown
        }
      }
      if (hbTimer) clearInterval(hbTimer)
      for (const conn of conns) conn.close()
      for (const conn of reservedConns) conn.close()
      await adapter.presence?.clearNode(instanceId) // remove this node's registry entries before disconnecting
      await adapter.close?.()
      for (const transport of opts.transports) await transport.stop()
    },
  }

  // The plugin's public capabilities: forward to `api` (minus implement/close) + the privileged block.
  function makePluginContext(pluginName: string): PluginContext {
    return {
      nodeId: instanceId,
      nodeName,
      instanceId,
      serializer,
      contract: c,
      get conns() {
        return [...conns]
      },
      get local() {
        return api.local
      },
      cluster: api.cluster,
      isOnline: (userId) => api.isOnline(userId),
      publish: (topic, data) => publishTo('shared', topic, data),
      subscribe: (topic, handler) => api.subscribe(topic as never, handler as never),
      toConn: (id) => {
        const t = api.toConn(id)
        return { emit: (event, data) => t.emit(event as never, data as never), close: t.close }
      },
      toUser: (userId) => {
        const t = api.toUser(userId)
        return { emit: (event, data) => t.emit(event as never, data as never), disconnect: t.disconnect }
      },
      room: (name) => {
        const r = room(name)
        return {
          add: (conn) => r.add(conn),
          remove: (conn) => r.remove(conn),
          broadcast: (event, data) => r.broadcast(event as never, data as never),
          get size() {
            return r.size
          },
          get connections() {
            return r.connections
          },
        }
      },
      collection: (name) => api.collection(name as CollectionName<C>) as ServerCollectionHandle,
      collectionInfos: () => collections.infos(),
      describe: (conn) => buildDescriptor(conn),
      connectionById: (id) => Promise.resolve(presenceOrThrow().get(id)),
      channel: (name) => pluginChannel(pluginName, name),
    }
  }

  // every clientToServer key the contract knows (across shared + roles) — the orphan-handler guard
  const contractRequestKeys = new Set<string>(Object.keys(c.shared?.clientToServer ?? {}))
  for (const role of Object.keys(c.roles))
    for (const k of Object.keys(c.roles[role]?.clientToServer ?? {})) contractRequestKeys.add(k)

  for (const p of plugins) {
    const ctx = makePluginContext(p.name)
    if (p.handlers) {
      for (const [key, fn] of Object.entries(p.handlers(ctx))) {
        if (!contractRequestKeys.has(key))
          throw new Error(`Plugin '${p.name}' handles '${key}', which the contract has no request for — did you forget to merge its surface?`)
        if (key in pluginHandlers)
          throw new Error(`Plugin handler collision on '${key}' (already provided by another plugin)`)
        pluginHandlers[key] = fn as AnyHandler
      }
    }
    if (p.connection)
      reservedServing.set(p.connection.role, {
        connection: p.connection,
        handlers: p.connection.handlers?.(ctx) ?? {},
        ctx,
      })
    const dispose = p.setup?.(ctx)
    if (dispose) pluginDisposers.push(dispose)
  }

  return api
}
