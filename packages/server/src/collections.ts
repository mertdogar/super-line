import type { Expr, CollectionQuery, CrdtServerReplica, DocListOpts, DocSummary } from '@super-line/core'

type Awaitable<T> = T | Promise<T>

/** The three row mutations a write policy guards. */
export type WriteOp = 'insert' | 'update' | 'delete'

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
