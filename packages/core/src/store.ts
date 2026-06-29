/**
 * Store — super-line's pluggable persisted-state seam.
 *
 * A Store persists Resources (`{ id, accessRules, data }`) and defines a single consistency model
 * (how a write mutates `data`). It ships as a pair, like a transport: a {@link ServerStore}
 * (persistence + change-notify) and a {@link ClientStore} (a reactive local replica). super-line core
 * relays opaque {@link StoreChange}s between the halves and enforces access — it never parses `update`.
 * "One plumbing, two consistency models": a last-writer-wins memory store and a merging CRDT store are
 * siblings behind this interface.
 */

type Awaitable<T> = T | Promise<T>

/**
 * Return a structural clone of `root` with the value at `path` removed — the surgical-delete primitive shared
 * by every Store's replica halves. Clones only along the path (not a deep clone): fed to a diff-and-patch
 * `set`, only the removed key is rewritten, so concurrent edits to sibling keys still merge. Never mutates
 * `root` (the live snapshot must stay intact). `path === []` returns `root` unchanged.
 */
export const removeAtPath = (root: unknown, path: (string | number)[]): unknown => {
  if (path.length === 0) return root
  if (typeof root !== 'object' || root === null) return root
  const [head, ...rest] = path
  if (Array.isArray(root)) {
    const next = root.slice()
    if (rest.length === 0) next.splice(Number(head), 1)
    else next[Number(head)] = removeAtPath(next[Number(head)], rest)
    return next
  }
  const next: Record<string, unknown> = { ...(root as Record<string, unknown>) }
  if (rest.length === 0) delete next[head as string]
  else next[head as string] = removeAtPath(next[head as string], rest)
  return next
}

/** The ACL identity a Resource's access is keyed by (`identify(conn) ?? conn.id`). */
export type Principal = string

/** Per-principal capabilities on a Resource. */
export interface Perms {
  read: boolean
  write: boolean
}

/** A Resource's access map: which {@link Principal} may read/write. Server-authoritative, deny-by-default. */
export type AccessRules = Record<Principal, Perms>

/** The unit a Store persists. `data` is opaque to core (a CRDT doc for a merging store, plain JSON for LWW). */
export interface Resource<T = unknown> {
  id: string
  accessRules: AccessRules
  data: T
}

/**
 * What a Store emits when a Resource mutates — and the symmetric shape a write carries IN.
 * `update` is a store-DEFINED opaque payload (a CRDT delta, or a full JSON value for last-writer-wins);
 * core relays it without parsing (base64 it if it's bytes under the JSON serializer). `origin` is the
 * per-writer id used for echo-break — never the {@link Principal}, never the CRDT actor id.
 */
export interface StoreChange {
  id: string
  update: unknown
  origin: string
}

/**
 * The server half of a Store pair: persistence + the consistency model + change-notification.
 * It does NOT enforce access (core does) and does NOT touch the wire. `apply` interprets a
 * {@link StoreChange} per its consistency model (LWW replace vs CRDT merge); every applied mutation —
 * client write, server co-write, or relayed remote change — must surface through {@link ServerStore.onChange},
 * which is core's single fan-out source.
 */
export interface ServerStore {
  /**
   * How cross-node sync happens: `relay` (core relays Changes over the adapter; each node a replica)
   * or `self` (the store owns a shared backend and core fans only to local subscribers).
   */
  readonly clustering: 'relay' | 'self'
  /** Consistency model, surfaced to the inspector for display. Optional; omit if a backend has no clean label. */
  readonly model?: 'lww' | 'crdt'
  /** Current snapshot of a Resource (for catch-up on subscribe), or undefined if absent. */
  read(id: string): Awaitable<Resource | undefined>
  /** Create a Resource with initial data + access rules (server-authoritative). */
  create(id: string, data: unknown, accessRules: AccessRules): Awaitable<void>
  /** Apply an inbound Change — replace (LWW) or merge (CRDT), the store's choice. */
  apply(change: StoreChange): Awaitable<void>
  /** Replace a Resource's access rules. */
  setAccess(id: string, accessRules: AccessRules): Awaitable<void>
  /** Remove a Resource. */
  delete(id: string): Awaitable<void>
  /** All Resource ids in this store (core ACL-filters before returning ids to a client). */
  list(): Awaitable<string[]>
  /** Subscribe to every applied mutation — the single fan-out source. Returns an unsubscribe fn. */
  onChange(cb: (change: StoreChange) => void): () => void
  /**
   * Subscribe to Resource deletions — the delete-side mirror of {@link ServerStore.onChange}, for
   * `self`-clustering stores whose backend owns cross-node propagation (e.g. an Electric-synced local
   * replica firing a `live.changes` delete). Core fans each id to LOCAL subscribers as an `sdel`. Optional;
   * `relay` stores omit it (core fans their deletes over the adapter from `server.store(n).delete`).
   * Returns an unsubscribe fn.
   */
  onDelete?(cb: (id: string) => void): () => void
  /**
   * Open a reactive in-process replica over a Resource's canonical state — the server-side co-writer.
   * Optional; stores opt in (those that don't, surface as "reactive open not supported"). Mutations made
   * through it fan out via {@link ServerStore.onChange} exactly like {@link ServerStore.apply}. `origin`
   * (default `"server"`) is stamped on its fan-out Changes for echo-break + inspector attribution.
   */
  open?(id: string, opts?: { origin?: string }): ServerReplica
  /** Release any resources held by the store. */
  close?(): Awaitable<void>
}

/**
 * The client half of a Store pair: a reactive local replica per opened Resource. A last-writer-wins
 * client wraps a plain value; a CRDT client wraps super-store's `StoreValue` and merges deltas.
 */
export interface ClientStore {
  /** This client's per-writer id, stamped as {@link StoreChange.origin} for echo-break. */
  readonly origin: string
  /** Open a reactive replica for one Resource. */
  open(id: string): ResourceReplica
  /** Release any resources held by the store. */
  close?(): void
}

/**
 * A reactive handle over one opened Resource (mirrors super-store's `StoreValue` surface).
 * `set`/`update` return the {@link StoreChange} to send up (null on a no-op); `applyRemote` merges an
 * inbound Change (own-origin merges are idempotent / no-ops); `seed` hydrates the catch-up snapshot.
 */
export interface ResourceReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void
  set(data: unknown): StoreChange | null
  update(partial: unknown): StoreChange | null
  /** Remove the value at `path` (a surgical key removal that merges, unlike a full-doc `set`). */
  delete(path: (string | number)[]): StoreChange | null
  applyRemote(change: StoreChange): void
  seed(snapshot: unknown): void
  /** Mark this Resource deleted (server fan-out of a `delete`) + notify subscribers, so consumers re-read. */
  applyDelete(): void
}

/**
 * A reactive **server-side** replica over one Resource's canonical state — the server half's mirror of
 * {@link ResourceReplica}, simpler because the server mutates canonical state directly: there is no wire to
 * send up (no return Change to forward) and no second copy to reconcile (no `applyRemote`/`seed`). `set`/
 * `update`/`delete` mutate canonical state in place and fan out through {@link ServerStore.onChange}; reads
 * are live and `subscribe` reflects every applied mutation (local co-writes AND relayed remote Changes).
 * Returned by {@link ServerStore.open}; surfaced to apps as `srv.store(name).open(id)`.
 */
export interface ServerReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void
  set(data: unknown): void
  update(partial: unknown): void
  delete(path: (string | number)[]): void
  close(): void
}
