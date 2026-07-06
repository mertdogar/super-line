/**
 * CrdtCollectionStore — the persistence seam for the CRDT document collection family (ADR-0007).
 *
 * The relational {@link CollectionStore} sibling for merging documents: one backend serves every CRDT
 * collection a server declares, keyed by `(collection, id)`. It is the relocated `ServerStore` engine minus
 * the stored `accessRules` ACL (Q7: access is server-side policy callbacks, not stored per-doc) and plus a
 * **validate-before-commit** hook on {@link CrdtCollectionStore.apply}: the backend holds the live doc, so it
 * can apply a delta to a scratch copy, snapshot to plaintext, and let the server validate against the contract
 * schema BEFORE committing — the mechanism that makes an opaque CRDT delta validatable (overturning ADR-0003).
 *
 * `update` on the wire is an opaque base64 Yjs delta; core relays it without parsing. The backend owns all
 * CRDT work (encode/apply/merge) via super-store; the server moves bytes, gates access, and validates.
 */

import type { DocOptions } from './contract.js'
import type { ResourceReplica } from './store.js'

type Awaitable<T> = T | Promise<T>

/** What the backend emits/ingests when a doc mutates: an opaque base64 Yjs delta, attributed by `origin` for echo-break. */
export interface DocChange {
  /** Collection name. */
  n: string
  /** Document id. */
  id: string
  /** Opaque base64 Yjs delta. */
  update: string
  /** Per-writer id for echo-break — never the principal, never the CRDT actor id. */
  origin: string
}

/** A per-document summary from {@link CrdtCollectionStore.list} — id enumeration only (Q4: no content query). */
export interface DocSummary {
  id: string
  createdAt: number
  updatedAt: number
}

/** Filter / sort / paginate options for {@link CrdtCollectionStore.list}. Id-substring only — CRDT docs aren't content-queryable. */
export interface DocListOpts {
  idContains?: string
  sort?: { by: 'id' | 'createdAt' | 'updatedAt'; dir: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

/**
 * A reactive server-side replica over one CRDT document's canonical state — the co-writer surface
 * (`srv.collection(n).open(id)`). Mutations fan out through {@link CrdtCollectionStore.onChange} exactly like
 * a relayed client delta; `origin` (default `"server"`) attributes them. Mirrors super-store's `StoreValue`.
 */
export interface CrdtServerReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void
  set(data: unknown): void
  update(partial: unknown): void
  /** Surgical key removal (merges, unlike a full-doc `set`). */
  delete(path: (string | number)[]): void
  close(): void
}

/**
 * The server half of a CRDT collection backend. Does NOT enforce access or validate schemas itself — the
 * server does both (policy callbacks + the {@link CrdtCollectionStore.apply} validate hook). One backend
 * serves all of a server's CRDT collections.
 */
export interface CrdtCollectionStore {
  /** Cross-node sync mode, inherited from the store family: `relay` (core relays deltas over the adapter) or `self`. */
  readonly clustering: 'relay' | 'self'
  /** Full encoded Yjs state (base64) for catch-up on open, or undefined if the doc doesn't exist. */
  read(n: string, id: string): Awaitable<string | undefined>
  /** Server-authoritative create with pre-validated initial data (Q10). Throws `CONFLICT` if the id exists. */
  create(n: string, id: string, data: unknown, opts: DocOptions | undefined): Awaitable<void>
  /**
   * Apply an inbound delta (client write or relayed remote change), gated by validate-before-commit: the
   * backend computes the post-merge plaintext on a scratch copy and calls `validate(snapshot)`; if it throws,
   * nothing is committed and the throw propagates (the server resyncs the writer). On success it commits,
   * fires {@link CrdtCollectionStore.onChange}, and returns. `NOT_FOUND` if the doc is absent.
   */
  apply(change: DocChange, opts: DocOptions | undefined, validate: (snapshot: unknown) => void): Awaitable<void>
  /** Remove a document (idempotent). */
  delete(n: string, id: string): Awaitable<void>
  /** Id-enumeration + summaries for a collection (Q4) — no content query. */
  list(n: string, opts?: DocListOpts): Awaitable<DocSummary[]>
  /** Open a reactive in-process co-writer over an existing doc's canonical state. */
  open(n: string, id: string, opts?: { origin?: string; doc?: DocOptions }): CrdtServerReplica
  /** Subscribe to every applied delta across all CRDT collections — core's single fan-out source. */
  onChange(cb: (change: DocChange) => void): () => void
  /** Deletion mirror for `self` backends that own cross-node propagation (see {@link CollectionStore.onChange}). */
  onDelete?(cb: (n: string, id: string) => void): () => void
  /** Release any resources held by the backend. */
  close?(): Awaitable<void>
}

/**
 * The client half of a CRDT collection engine: builds a reactive super-store replica per opened document.
 * Engine-agnostic seam — the client stays free of super-store; the app supplies this (e.g.
 * `crdtCollectionsClient()` from `@super-line/collections-crdt-memory`). Universal across durability tiers:
 * the client only merges opaque deltas, so one client engine pairs with every CRDT backend.
 */
export interface CrdtCollectionClient {
  /** This client's per-writer id, stamped as {@link DocChange.origin} for echo-break. */
  readonly origin: string
  /** Open a reactive local replica for one document, built with the collection's {@link DocOptions}. */
  open(n: string, id: string, opts: DocOptions | undefined): ResourceReplica
}
