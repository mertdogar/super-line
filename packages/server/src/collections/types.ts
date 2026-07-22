import type {
  Expr,
  CollectionDef,
  CollectionQuery,
  CollectionStore,
  CrdtCollectionStore,
  CrdtServerReplica,
  DocListOpts,
  DocSummary,
  MessageError,
  RowTimestamps,
  TapEvent,
} from '@super-line/core'
import type { Cluster } from '../cluster.js'

type Awaitable<T> = T | Promise<T>

/** The three row mutations a write policy guards. */
export type WriteOp = 'insert' | 'update' | 'delete'

export type ServerCollectionOp =
  | { op: 'insert' | 'update'; collection: string; row: unknown }
  | { op: 'delete'; collection: string; id: string }

/**
 * Everything the Collection runtime needs from a connection — the whole of it. The server's `Conn` class
 * satisfies this structurally, so nothing adapts at the call site; stating it as its own interface is what
 * lets a test hand the runtime an object literal instead of a socket, and records that collections touch
 * none of `Conn`'s heartbeat state or its raw transport.
 */
export interface CollectionConn {
  readonly id: string
  readonly role: string
  readonly ctx: unknown
  /** The ACL identity (`identify(conn) ?? conn.id`); always set once the connection is accepted. */
  readonly principal?: string
  send(frame: unknown): void
  /** Send pre-encoded bytes — one buffer to N connections, no re-encode per recipient. */
  sendRaw(payload: string | Uint8Array): void
}

/** What a Collection *is*: the backends behind it and the contract-declared shape of what they hold. */
export interface CollectionRuntimeConfig {
  /** The single row backend serving every row collection (one tx domain → atomic cross-collection batches). */
  store?: CollectionStore
  /** The CRDT document backend. Separate by construction: a CRDT doc never joins a row batch. */
  crdtStore?: CrdtCollectionStore
  /** Contract-declared collections, both families, keyed by name. */
  defs: Record<string, CollectionDef>
  /**
   * Row + CRDT policies keyed by collection name. One map, two value shapes — the contract's `crdt` key
   * decides which, and {@link CollectionRuntimeConfig.defs} is the discriminator.
   */
  policies: Record<string, unknown>
  /** Opt-in advisory foreign-key checking on writes (no cascades). */
  checkReferences: boolean
}

/**
 * What the server *provides* to the Collection runtime. Each entry is a capability, not a raw handle: the
 * runtime never learns that publishing needs encoding, that echo-break is spelled `nd`, or that observation
 * has a cost. That is the difference between this module having an interface and merely having a file.
 */
export interface CollectionHost {
  /**
   * The shared op spine: run host + plugin middleware, then `terminal`; on a throw, route to `onError`, send
   * the client an `err` frame, and fire the host's error hook. Collections pass their own `onError` so the
   * failure surfaces as a `collection.*` tap rather than a generic `msg.response`.
   */
  dispatch(
    conn: CollectionConn,
    id: number,
    info: { kind: 'request' | 'subscribe'; name: string; conn: CollectionConn },
    terminal: () => Promise<void>,
    onError?: (error: MessageError) => void,
  ): Promise<void>
  /** Node identity on the wire. Owns stamping + detection; the delivery policy stays here (see {@link Cluster}). */
  cluster: Cluster
  /** The channel registry rooms and topics already share. Only CRDT documents use it; rows never do. */
  channels: {
    /** Sync when the node already holds the channel, async when it must subscribe the Adapter first. */
    join(conn: CollectionConn, channel: string): Awaitable<void>
    leave(conn: CollectionConn, channel: string): void
    membersOf(channel: string): Set<CollectionConn> | undefined
  }
  /**
   * Emit an inspector/plugin tap. Takes a thunk, not an event: building a tap payload costs a snapshot, and
   * with no plugin tapping, the thunk is never called. Collections therefore never guard their own emits.
   */
  tap(event: () => TapEvent): void
  /**
   * Encode a frame for `sendRaw`. Needed only by the `self` CRDT path, which fans out to local subscribers
   * without a node hop: it encodes once and passes one buffer to N connections. Everything that *does* cross
   * a node boundary goes through {@link Cluster.broadcast}, which encodes and stamps for itself — so a frame
   * encoded here deliberately carries no node id, because it was never published.
   */
  encode(frame: object): string | Uint8Array
}

/**
 * Row-security policy for one collection (see ADR-0006, decision 7). Server-side only — callbacks, never
 * serialized to clients. **Deny-by-default**: omit `read` and clients cannot read the collection at all;
 * omit `write` and clients cannot write it. Server co-writes via `srv.collection(n)` bypass both.
 */
export interface CollectionPolicy<Ctx = unknown, Row = unknown> {
  /**
   * A caller's visibility filter, ANDed into every snapshot, subscription, and change-route for that caller.
   * Return `undefined` for "no filter" (the whole collection is visible). Return an {@link Expr} to restrict.
   * Caveat: it is evaluated at subscribe time; principal-side state captured here (e.g. the caller's channel
   * list) goes stale until the client resubscribes — row-side predicates re-evaluate on every change naturally.
   */
  read?: (principal: string, ctx: Ctx) => Awaitable<Expr | undefined>
  /**
   * Per-row write guard. `next` is the incoming row (absent on delete), `prev` the current row (absent on
   * insert). Return `false` to reject the op — which aborts the whole atomic batch it belongs to.
   */
  write?: (principal: string, op: WriteOp, next: Row | undefined, prev: Row | undefined, ctx: Ctx) => Awaitable<boolean>
}

/**
 * Server-authoritative handle for a collection (`srv.collection('messages')`). Writes bypass row policy
 * (server is authoritative) but are still schema-validated, fan out, and — under relay — replicate across
 * nodes exactly like a client batch. The door for business-logic mutations that a contract request handler owns.
 */
export interface ServerCollectionHandle<Row = unknown> {
  /** Insert a row (its `key` field becomes the id). Throws `CONFLICT` if the id already exists. */
  insert(row: Row): Promise<void>
  /** Replace a row by its `key` (LWW). Throws `NOT_FOUND` if absent. */
  update(row: Row): Promise<void>
  /** Delete a row by id (idempotent). */
  delete(id: string): Promise<void>
  /** Read one row by id, or undefined. */
  read(id: string): Promise<Row | undefined>
  /** Materialize a snapshot (filter/sort/limit); omit the query for the whole collection. Server-side, policy-free. */
  snapshot(query?: CollectionQuery): Promise<Row[]>
  /** Inspector-only: per-row created/updated timestamps keyed by id. Absent unless the backend tracks them. */
  rowMeta?(ids: string[]): Promise<Record<string, RowTimestamps>>
}

/**
 * Access policy for a CRDT document collection (ADR-0007, Q7). Guard-shaped — not the RLS filter shape of
 * {@link CollectionPolicy}, because CRDT collections are opened by id (no subset to filter). **Deny-by-default**.
 * Server co-writes via `srv.collection(n)` bypass both.
 */
export interface CrdtCollectionPolicy<Ctx = unknown, Doc = unknown> {
  /** May this principal open `id`? Gets the post-merge plaintext `snapshot` (content-based auth like RLS reading a row). */
  read?: (principal: string, id: string, snapshot: Doc | undefined, ctx: Ctx) => Awaitable<boolean>
  /** May this principal write to `id`? (Creation is server-authoritative — Q10 — so there is no `create` op here.) */
  write?: (principal: string, id: string, ctx: Ctx) => Awaitable<boolean>
}

/**
 * Server-authoritative handle for a CRDT document collection (`srv.collection('scenes')`). Creation is
 * server-only (Q10): `create` validates the initial doc and materializes it; `open` returns a reactive
 * co-writer whose mutations fan out like a relayed client delta. Policy-free (server is authoritative).
 */
export interface ServerCrdtCollectionHandle<Doc = unknown> {
  /** Create a document with pre-validated initial data. Throws `CONFLICT` if the id exists. */
  create(id: string, data: Doc): Promise<void>
  /** Open a reactive co-writer over an existing document. `origin` (default `"server"`) attributes its writes. */
  open(id: string, opts?: { origin?: string }): CrdtServerReplica
  /** Read the current plaintext snapshot of a document, or undefined if absent. */
  read(id: string): Promise<Doc | undefined>
  /** Delete a document (idempotent), fanning the deletion cluster-wide. */
  delete(id: string): Promise<void>
  /** Enumerate document ids + summaries (no content query). */
  list(opts?: DocListOpts): Promise<DocSummary[]>
}
