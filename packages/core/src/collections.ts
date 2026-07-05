/**
 * CollectionStore — the persistence seam for the typed-row collection family (ADR-0006).
 *
 * Unlike {@link ServerStore} (one namespace = many independent documents), ONE CollectionStore serves
 * every collection a server declares, so a cross-collection batch commits in a single transaction domain
 * (decision 13). The backend is deliberately dumb about policy and schema — exactly as {@link ServerStore}
 * is dumb about ACLs. Core validates rows against the contract schema and enforces row policies BEFORE
 * calling {@link CollectionStore.apply}; the backend only persists rows and reports what changed.
 *
 * Change routing lives in the server and is stateless per subscription: it evaluates each {@link RowChange}
 * (which carries both `prev` and `next`) against connections' effective filters, so a row that moves out of
 * a filter on update is delivered too (the client removes it). See the wire `cchg` frame.
 */

import type { CollectionQuery } from './query.js'

type Awaitable<T> = T | Promise<T>

/** A row op resolved by core: id already extracted from `row[key]`, row already schema-validated. `delete` carries no row. */
export type ResolvedRowOp =
  | { op: 'insert'; n: string; id: string; row: unknown }
  | { op: 'update'; n: string; id: string; row: unknown }
  | { op: 'delete'; n: string; id: string }

/** What the backend emits when a row mutates. `prev`/`next` drive enter/leave routing; `origin` echo-breaks + attributes. */
export interface RowChange {
  n: string
  k: 'insert' | 'update' | 'delete'
  id: string
  prev?: unknown
  next?: unknown
  origin: string
}

export interface CollectionStore {
  /**
   * Cross-node sync mode, inherited from the store family: `relay` (core relays batches over the adapter;
   * each node a full replica) or `self` (the backend owns cross-node propagation; core fans locally only).
   */
  readonly clustering: 'relay' | 'self'
  /**
   * Apply a batch of resolved row ops **atomically** — all-or-nothing on the handling node. Persists, fires
   * {@link CollectionStore.onChange} once per resulting change, and returns those changes. Throws to abort
   * the whole batch (nothing persisted, nothing emitted): `CONFLICT` if an `insert` id exists, `NOT_FOUND`
   * if an `update` targets an absent id. `delete` of an absent id is a silent no-op. This is the ingest
   * point for BOTH client batches and relayed remote batches. `origin` echo-breaks the writer.
   */
  apply(ops: ResolvedRowOp[], origin: string): Awaitable<RowChange[]>
  /** Materialize a collection's snapshot for the initial subscribe: filter → sort → offset/limit (core injects the policy filter). */
  snapshot(n: string, query: CollectionQuery): Awaitable<unknown[]>
  /** Read one row by primary key — for write-policy `prev` and advisory FK checks. Undefined if absent. */
  read(n: string, id: string): Awaitable<unknown | undefined>
  /** Subscribe to every applied row change across all collections — core's single fan-out source. Returns an unsubscribe fn. */
  onChange(cb: (change: RowChange) => void): () => void
  /** Release any resources held by the backend. */
  close?(): Awaitable<void>
}
