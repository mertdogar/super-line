/**
 * CRDT-replica primitives — the sliver of the retired Store seam (ADR-0007 Phase 3b) that the CRDT document
 * collections still build on. The `store(n)` API and its `ServerStore`/`ClientStore` pair are gone; what remains
 * is the reactive local-replica shape ({@link ResourceReplica}), the opaque change it relays ({@link StoreChange}),
 * and the surgical-delete primitive ({@link removeAtPath}) that the client `DocHandle` and CRDT backends reuse.
 */

/**
 * Return a structural clone of `root` with the value at `path` removed — the surgical-delete primitive.
 * Clones only along the path (not a deep clone): fed to a diff-and-patch `set`, only the removed key is
 * rewritten, so concurrent edits to sibling keys still merge. Never mutates `root`. `path === []` returns `root`.
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

/**
 * What a CRDT replica emits when a document mutates — and the symmetric shape a write carries IN. `update` is an
 * opaque payload (a Yjs delta, base64 under the JSON serializer); core relays it without parsing. `origin` is the
 * per-writer id used for echo-break.
 */
export interface StoreChange {
  id: string
  update: unknown
  origin: string
}

/**
 * A reactive handle over one opened CRDT document (mirrors super-store's `StoreValue` surface). `set`/`update`
 * return the {@link StoreChange} to send up (null on a no-op); `applyRemote` merges an inbound Change (own-origin
 * merges are idempotent); `seed` hydrates the catch-up snapshot. Implemented by the client `DocHandle` replica.
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
  /**
   * Hard-resync to authoritative full state, **discarding** any local optimistic edits — unlike `seed`, which
   * merges. Used by CRDT document collections after a server rejects a write (validate-before-commit, ADR-0007):
   * the rejected edit was applied optimistically and must be thrown away.
   */
  reset?(snapshot: unknown): void
  /** Mark this document deleted (server fan-out of a `delete`) + notify subscribers, so consumers re-read. */
  applyDelete(): void
}
