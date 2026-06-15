/**
 * Cross-node fan-out seam. Rooms, topics, and serverToServer all compile down to
 * channel pub/sub. A node subscribes to a channel only while it has a local member,
 * and publishes always go through the adapter (the in-memory adapter loops back),
 * so a node delivers to its local members on receipt — one code path, no double-send.
 *
 * The default is a per-server in-memory adapter; use `@super-line/adapter-redis`
 * to fan out across processes.
 */
export interface Adapter {
  /** Start receiving messages published to `channel`. */
  subscribe(channel: string): void | Promise<void>
  /** Stop receiving messages for `channel`. */
  unsubscribe(channel: string): void | Promise<void>
  /** Publish an encoded payload to `channel` (delivered to every subscribed node). */
  publish(channel: string, payload: string | Uint8Array): void | Promise<void>
  /** Register the handler invoked for each message on a subscribed channel. */
  onMessage(handler: (channel: string, payload: string | Uint8Array) => void): void
  /** Optional teardown (e.g. close Redis connections). */
  close?(): void | Promise<void>
  /**
   * Optional cluster-wide presence directory. Powers `srv.cluster.*` and
   * `srv.isOnline`. The in-memory and Redis adapters implement it; cluster
   * queries throw a clear error on an adapter that doesn't.
   */
  presence?: PresenceStore
}

/** A serializable snapshot of a connection, shared cluster-wide via the {@link PresenceStore}. */
export interface ConnDescriptor {
  /** The connection's server-assigned id. */
  id: string
  /** The connection's role. */
  role: string
  /** The node that holds this connection. */
  nodeId: string
  /** When the connection was accepted (`Date.now()`). */
  connectedAt: number
  /** The stable user key from the server's `identify` hook, if any. */
  userId?: string
  /** Room memberships (topics and node-local `lastPongAt` are not included). */
  rooms: string[]
  /** Extra fields contributed by the server's `describeConn` hook. */
  [extra: string]: unknown
}

/** Per-node aggregate, returned by {@link PresenceStore.topology}. */
export interface NodeStat {
  /** The node's id. */
  nodeId: string
  /** Number of connections on the node. */
  connections: number
  /** Number of distinct rooms with members on the node. */
  rooms: number
  /** Whether the node is currently live (heartbeat fresh). */
  alive: boolean
}

/**
 * Cluster-wide presence directory: a query/addressbook layer kept in the shared
 * substrate (in-memory bus or Redis). Live message delivery does NOT read this —
 * it exists only to answer `srv.cluster.*` / `srv.isOnline`.
 */
export interface PresenceStore {
  /** Record (or replace) a connection's descriptor. */
  set(descriptor: ConnDescriptor): void | Promise<void>
  /** Remove a connection's descriptor. */
  del(connId: string): void | Promise<void>
  /** Refresh this node's liveness (heartbeat). */
  beat(nodeId: string): void | Promise<void>
  /** Add a room to a connection's membership. */
  addRoom(connId: string, room: string): void | Promise<void>
  /** Remove a room from a connection's membership. */
  removeRoom(connId: string, room: string): void | Promise<void>
  /** All live connection descriptors across the cluster. */
  list(): ConnDescriptor[] | Promise<ConnDescriptor[]>
  /** One connection's descriptor, if present. */
  get(connId: string): (ConnDescriptor | undefined) | Promise<ConnDescriptor | undefined>
  /** Descriptors for a given user key. */
  byUser(userId: string): ConnDescriptor[] | Promise<ConnDescriptor[]>
  /** Descriptors that are members of `room`. */
  roomMembers(room: string): ConnDescriptor[] | Promise<ConnDescriptor[]>
  /** Total live connection count across the cluster. */
  count(): number | Promise<number>
  /** Per-node aggregates. */
  topology(): NodeStat[] | Promise<NodeStat[]>
}
