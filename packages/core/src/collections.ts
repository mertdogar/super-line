/**
 * CollectionStore — the persistence seam for the typed-row collection family (ADR-0006).
 *
 * Unlike a per-id document store (one namespace = many independent documents), ONE CollectionStore serves
 * every collection a server declares, so a cross-collection batch commits in a single transaction domain
 * (decision 13). The backend is deliberately dumb about policy and schema. Core validates rows against the
 * contract schema and enforces row policies BEFORE
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

/** Per-row store metadata: creation / last-update wall-clock (epoch ms). Surfaced by the inspector only (ADR-0006). */
export interface RowTimestamps {
  createdAt: number
  updatedAt: number
}

/** Reserved row keys the inspector injects for the Control Center's created/updated columns — never part of your schema. */
export const ROW_CREATED_AT = '_createdAt'
export const ROW_UPDATED_AT = '_updatedAt'

/**
 * Merge {@link RowTimestamps} onto a row under the reserved {@link ROW_CREATED_AT}/{@link ROW_UPDATED_AT} keys —
 * the inspector-side projection for the Control Center. A no-op when `meta` is absent or the row isn't an object,
 * so client-facing rows (which never carry meta) pass through unchanged.
 */
export function withRowMeta(row: unknown, meta: RowTimestamps | undefined): unknown {
  if (!meta || typeof row !== 'object' || row === null) return row
  return { ...(row as Record<string, unknown>), [ROW_CREATED_AT]: meta.createdAt, [ROW_UPDATED_AT]: meta.updatedAt }
}

/** The members every backend provides, whatever its {@link CollectionStore} clustering mode. */
interface CollectionStoreBase {
  /** Materialize a collection's snapshot for the initial subscribe: filter → sort → offset/limit (core injects the policy filter). */
  snapshot(n: string, query: CollectionQuery): Awaitable<unknown[]>
  /** Read one row by primary key — for write-policy `prev` and advisory FK checks. Undefined if absent. */
  read(n: string, id: string): Awaitable<unknown | undefined>
  /**
   * Inspector-only: per-row {@link RowTimestamps} keyed by row id, for `ids` in collection `n`. The client
   * subscribe path never sees these (rows stay exactly your schema) — timestamps are surfaced solely by the
   * Control Center. Absent ⇒ the backend doesn't track row timestamps; the inspector shows no created/updated.
   */
  rowMeta?(n: string, ids: string[]): Awaitable<Record<string, RowTimestamps>>
  /**
   * Subscribe to every applied row change across all collections — core's single fan-out source. Returns an
   * unsubscribe fn. **Who fires it depends on the mode**: a {@link RelayCollectionStore} fires it from
   * `apply`; a {@link SelfCollectionStore} fires it from its replication feed instead. That difference is
   * the one thing this seam cannot state in its types (the signature is identical either way), so it is
   * stated here and pinned by the conformance suite.
   */
  onChange(cb: (change: RowChange) => void): () => void
  /** Release any resources held by the backend. */
  close?(): Awaitable<void>
}

/**
 * A node-local replica. Core relays each batch across nodes over the Adapter and re-ingests remote batches
 * through {@link RelayCollectionStore.apply}, so every node converges to the same rows.
 */
export interface RelayCollectionStore extends CollectionStoreBase {
  readonly clustering: 'relay'
  /**
   * See {@link CollectionStore} for the shared atomicity / error / timestamp contract. In `relay` mode apply
   * also **fires `onChange` once per resulting change before returning, and returns those changes**.
   *
   * **The non-void return type is load-bearing — do not "simplify" it to `void`.** It is the only thing
   * making an async implementation a compile error, and that is the invariant which keeps a relayed write
   * from echo-storming the cluster: the relay ingress fires-and-forgets (`void apply(...)`) so it can absorb
   * a cross-node race in a `try`/`catch`, and the CRDT sibling clears a re-publish guard in `finally`. An
   * async apply escapes that catch and clears that guard before the change is ever emitted. TypeScript's
   * void-return rule accepts a function returning *anything* where `void` is declared, so `apply(): void`
   * would silently permit `async apply()` again. `RowChange[]` does not.
   *
   * (`collections-crdt-libsql` had to discover this constraint on its own — sync hot path, debounced
   * `onChange` persistence — back when it lived only in prose. Now the compiler holds it.)
   */
  apply(ops: ResolvedRowOp[], origin: string): RowChange[]
}

/**
 * A backend that owns its own cross-node propagation (a central Postgres + a per-node replication feed).
 * Core never relays for it; it fans out only to this node's local subscribers.
 */
export interface SelfCollectionStore extends CollectionStoreBase {
  readonly clustering: 'self'
  /**
   * See {@link CollectionStore} for the shared atomicity / error / timestamp contract. In `self` mode apply
   * persists to the central backend and returns **nothing**, and does **not** fire `onChange`: the backend's
   * replication feed surfaces the change on *every* node, including this one, so firing here would
   * double-deliver. It may be async — nothing relays it, so the synchrony `relay` demands does not apply.
   */
  apply(ops: ResolvedRowOp[], origin: string): Awaitable<void>
}

/**
 * The persistence seam for typed rows, **discriminated on `clustering`** (ADR-0009): the mode genuinely
 * changes `apply`'s contract — its synchrony, its return value, and whether it fires `onChange` — rather
 * than only telling core how to route around it.
 *
 * Shared by both modes, `apply` is **atomic**: all-or-nothing on the handling node. It throws to abort the
 * whole batch (nothing persisted, nothing emitted) — `CONFLICT` if an `insert` id already exists,
 * `NOT_FOUND` if an `update` targets an absent id — while a `delete` of an absent id is a silent no-op (the
 * relay ingress leans on that to absorb cross-node races). It is the ingest point for BOTH client batches
 * and relayed remote batches, and `origin` echo-breaks the writer. Every row a batch touches carries the
 * **same** `createdAt`/`updatedAt`: the batch is atomic, so it happened at one instant — read the clock once
 * per batch, not once per op.
 *
 * Consumers that only read (`read` / `snapshot` / `onChange`) can use this union directly and never narrow.
 * Every clause above, and each mode's differences, are pinned by `core/test/collection-store-conformance.ts`.
 */
export type CollectionStore = RelayCollectionStore | SelfCollectionStore
