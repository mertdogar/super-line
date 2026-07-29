import { SuperLineError, removeAtPath } from '@super-line/core'
import type {
  CrdtCollectionClient,
  CrdtCollectionStore,
  CrdtServerReplica,
  DocChange,
  DocOptions,
  DocSummary,
  ResourceReplica,
  StoreChange,
} from '@super-line/core'
import { StoreValue, type StoreMode } from '@super-store/store'

// The in-memory CRDT document collection backend (ADR-0007) — the relocated store-sync engine, re-surfaced
// under the collection API. Holds one super-store Yjs doc per (collection, id); `update` on the wire is an
// opaque base64 Yjs delta the backend merges. Two differences from the old ServerStore it descends from:
// no stored accessRules (the server enforces policy callbacks) and a **validate-before-commit** gate on
// `apply` — the delta is merged onto a scratch copy and the post-merge plaintext validated by the server
// BEFORE the canonical doc is touched, so an invalid write never poisons the doc. `clustering: 'relay'`.

type Doc = StoreValue<Record<string, unknown>, StoreMode>

const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

const SERVER_ORIGIN = 'server'

interface Entry {
  sv: Doc
  off: () => void
  createdAt: number
  updatedAt: number
}

export function crdtMemoryCollections(): CrdtCollectionStore {
  const collections = new Map<string, Map<string, Entry>>() // collection name → (doc id → entry)
  const cbs = new Set<(change: DocChange) => void>()
  const now = (): number => Date.now()
  let currentOrigin = SERVER_ORIGIN // origin of the in-progress mutation; read synchronously by onUpdate

  const tableOf = (n: string): Map<string, Entry> => {
    let t = collections.get(n)
    if (!t) collections.set(n, (t = new Map()))
    return t
  }
  const entryOrThrow = (n: string, id: string): Entry => {
    const e = collections.get(n)?.get(id)
    if (!e) throw new SuperLineError('NOT_FOUND', `No document: ${n}/${id}`)
    return e
  }

  // Build a doc, force-bind (so the initial-bind update isn't fanned as a change), and wire onUpdate → fan-out.
  const build = (n: string, id: string, data: Record<string, unknown>, opts: DocOptions | undefined): Entry => {
    const sv = new StoreValue<Record<string, unknown>, StoreMode>(data, opts)
    sv.encodeState()
    const off = sv.onUpdate((update) => {
      const origin = currentOrigin
      for (const cb of cbs) cb({ n, id, update: b64(update), origin })
    })
    return { sv, off, createdAt: now(), updatedAt: now() }
  }

  return {
    clustering: 'relay',
    read(n, id) {
      const e = collections.get(n)?.get(id)
      return e ? b64(e.sv.encodeState()) : undefined // full state for catch-up
    },
    create(n, id, data, opts) {
      const t = tableOf(n)
      if (t.has(id)) throw new SuperLineError('CONFLICT', `Document already exists: ${n}/${id}`)
      t.set(id, build(n, id, (data ?? {}) as Record<string, unknown>, opts))
    },
    apply(change, opts, validate) {
      const e = entryOrThrow(change.n, change.id)
      const delta = fromB64(change.update)
      // Validate-before-commit: merge onto a scratch copy of canonical state and validate the post-merge
      // plaintext. If it throws, the canonical doc is never touched and the throw propagates (server resyncs).
      // No validator means the fold is SKIPPED, not run-and-ignored — it is the whole cost here (a full
      // encodeState + a second doc + a plaintext materialization), and it buys nothing for a relayed delta
      // (already validated at its ingress node) or an unvalidated collection.
      if (validate) {
        const scratch = new StoreValue<Record<string, unknown>, StoreMode>({}, opts)
        try {
          scratch.applyUpdate(e.sv.encodeState())
          scratch.applyUpdate(delta)
          validate(scratch.getSnapshot())
        } finally {
          scratch.dispose()
        }
      }
      currentOrigin = change.origin
      try {
        e.sv.applyUpdate(delta) // commit; onUpdate fans the delta out (idempotent no-op if already integrated)
      } finally {
        currentOrigin = SERVER_ORIGIN
      }
      e.updatedAt = now()
    },
    delete(n, id) {
      const e = collections.get(n)?.get(id)
      if (!e) return
      e.off()
      e.sv.dispose()
      collections.get(n)?.delete(id)
    },
    list(n, opts) {
      const { idContains, sort, limit, offset = 0 } = opts ?? {}
      let rows: DocSummary[] = [...(collections.get(n)?.entries() ?? [])].map(([id, e]) => ({
        id,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }))
      if (idContains) rows = rows.filter((r) => r.id.includes(idContains))
      const by = sort?.by ?? 'id'
      const mul = sort?.dir === 'desc' ? -1 : 1
      rows.sort((a, b) => {
        if (by === 'id') return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * mul
        return (a[by] - b[by]) * mul
      })
      return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit)
    },
    open(n, id, openOpts) {
      const e = entryOrThrow(n, id)
      const origin = openOpts?.origin ?? SERVER_ORIGIN
      const subs = new Set<() => void>()
      // Mutate canonical state with this replica's origin so onUpdate stamps it onto the fanned-out change.
      // Synchronous (no await gap) so the origin can't bleed across an interleaved apply.
      const withOrigin = (fn: () => void): void => {
        currentOrigin = origin
        try {
          fn()
          e.updatedAt = now()
        } finally {
          currentOrigin = SERVER_ORIGIN
        }
      }
      return {
        getSnapshot: () => e.sv.getSnapshot(),
        subscribe: (cb) => {
          const off = e.sv.subscribe(cb)
          subs.add(off)
          return () => {
            off()
            subs.delete(off)
          }
        },
        set: (data) => withOrigin(() => e.sv.set(data as Record<string, unknown>)),
        update: (partial) => withOrigin(() => e.sv.update(partial as Record<string, unknown>)),
        delete: (path) => withOrigin(() => e.sv.set(removeAtPath(e.sv.getSnapshot(), path) as Record<string, unknown>)),
        close: () => {
          for (const off of subs) off()
          subs.clear()
        },
      } satisfies CrdtServerReplica
    },
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
  }
}

const randomId = (): string => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

/** A CRDT local replica: a super-store `StoreValue`. Local writes produce a delta; remote changes merge. */
class CrdtDocReplica implements ResourceReplica {
  private sv: Doc
  private off!: () => void
  private svOff!: () => void
  // We own both subscriber sets (rather than delegating to `sv`) so subscriptions survive a reset(), which
  // swaps `sv` for a fresh doc — a bare `sv.subscribe` would be orphaned on the disposed doc.
  private readonly subs = new Set<() => void>()
  private readonly localSubs = new Set<(change: StoreChange) => void>()

  constructor(
    private readonly id: string,
    private readonly origin: string,
    private readonly opts: DocOptions | undefined,
  ) {
    this.sv = new StoreValue<Record<string, unknown>, StoreMode>({}, opts)
    this.bind()
  }
  private bind(): void {
    // Push every local update out as it happens. This used to park the delta in a one-slot field for the next
    // `set`/`update`/`delete` to collect, which was sound only while those were the sole writers — a native
    // root has no such call to return through, and two quick keystrokes would overwrite each other in the slot.
    // `onUpdate` binds the doc BEFORE attaching its listener, so the initial populate is not observed here.
    this.off = this.sv.onUpdate((update, meta) => {
      if (!meta.local) return
      const change: StoreChange = { id: this.id, update: b64(update), origin: this.origin }
      for (const cb of this.localSubs) cb(change)
    })
    this.svOff = this.sv.subscribe(() => {
      for (const cb of this.subs) cb()
    })
  }

  getSnapshot(): unknown {
    return this.sv.getSnapshot()
  }
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }
  onLocalChange(cb: (change: StoreChange) => void): () => void {
    this.localSubs.add(cb)
    return () => this.localSubs.delete(cb)
  }
  /**
   * The underlying Yjs document — see {@link yDocOf}, which types this without dragging Yjs into the client.
   *
   * **The returned document does not survive `reset`.** A rejected write rebuilds the replica on a fresh doc
   * (see `reset` for why a value-patch cannot do the job), orphaning anything bound to the old one. Since a
   * native root is invisible to validation, it can never cause that rejection itself — but a *described* field
   * in the same document can. So keep validatable state out of a document that carries a native root: give the
   * collection `crdt: { validate: false }` and model its metadata as an ordinary row collection beside it.
   */
  native(): unknown {
    return this.sv.doc
  }
  set(data: unknown): void {
    this.sv.set(data as Record<string, unknown>)
  }
  update(partial: unknown): void {
    this.sv.update(partial as Record<string, unknown>)
  }
  delete(path: (string | number)[]): void {
    this.sv.set(removeAtPath(this.sv.getSnapshot(), path) as Record<string, unknown>)
  }
  applyRemote(change: StoreChange): void {
    if (change.origin === this.origin) return // echo-break (our own write, already applied locally)
    if (typeof change.update === 'string') this.sv.applyUpdate(fromB64(change.update))
  }
  seed(snapshot: unknown): void {
    if (typeof snapshot === 'string') this.sv.applyUpdate(fromB64(snapshot)) // catch-up = full Yjs state
  }
  reset(snapshot: unknown): void {
    // Reject→resync (ADR-0007): REBUILD the doc from the authoritative Yjs *state* so it's byte-identical to the
    // server's. A `set()`-based value patch (the old approach) leaves client-only compensating ops AND stale
    // nested child handles, so the replica stays structurally divergent — every later write is malformed, fails
    // validation, and re-triggers resync (an endless loop). A fresh doc discards the rejected edit cleanly.
    // We re-point our subscribers at the new sv (we own both subscriber sets), so `useDoc` keeps working.
    // A handle taken from `native()` is NOT re-pointed and cannot be — it belongs to the doc being discarded.
    this.off()
    this.svOff()
    this.sv.dispose()
    this.sv = new StoreValue<Record<string, unknown>, StoreMode>({}, this.opts)
    if (typeof snapshot === 'string') this.sv.applyUpdate(fromB64(snapshot))
    this.bind()
    for (const cb of this.subs) cb() // notify: the value snapped back to authoritative
  }
  applyDelete(): void {
    this.sv.emitChange()
  }
}

/**
 * The universal client half for CRDT document collections — one reactive super-store replica per opened doc.
 * Pairs with EVERY CRDT backend tier (memory/durable/self): the client only merges opaque deltas.
 */
export function crdtCollectionsClient(opts?: { origin?: string }): CrdtCollectionClient {
  const origin = opts?.origin ?? randomId()
  return {
    origin,
    open(_n, id, docOpts, openOrigin) {
      return new CrdtDocReplica(id, openOrigin ?? origin, docOpts)
    },
  }
}

/**
 * The Yjs `Doc` type, derived from super-store's own accessor rather than imported from `yjs`. Naming the
 * package directly would risk a second physical copy of Yjs resolving here, and documents from two copies do
 * not interoperate — the CRDT equivalent of the duplicate-core `instanceof` trap. Deriving it guarantees this
 * is exactly the type of the instance super-store hands back.
 */
export type YDoc = Doc['doc']

/** Anything exposing an engine-native handle — `DocHandle` and `ResourceReplica` both qualify structurally. */
interface HasNative {
  native?(): unknown
}

/**
 * The Yjs document behind an open CRDT document handle — the seam for **native roots**, i.e. CRDT types bound
 * beside the contract-described root in the same document. Reach for it when a value's merge granularity is
 * finer than a field, which in practice means collaborative text: the described root is diff-and-patched whole
 * on every write, so a string living in it is replaced rather than merged, and two people typing in one
 * paragraph would clobber each other.
 *
 * A native root replicates with no further work — the wire already carries whole-document updates — and is
 * invisible to the plaintext snapshot, so validation, the queryable projection and the inspector never see it.
 * Give such a collection `crdt: { validate: false }`: there is nothing in the native root for the schema to
 * check, and validating the rest of the document per keystroke is what makes text unaffordable.
 *
 * It lives here rather than on `DocHandle` so that `@super-line/client` never acquires a Yjs dependency.
 *
 * @example
 * ```ts
 * import { yDocOf } from '@super-line/collections-crdt-memory'
 *
 * const doc = client.collection('prose').open(id)
 * await doc.ready
 * Collaboration.configure({ document: yDocOf(doc), field: 'body' })   // Tiptap's `field` IS the root key
 * ```
 * @throws If the handle's engine exposes no native document.
 */
export function yDocOf(handle: HasNative): YDoc {
  const doc = handle.native?.()
  if (!doc) throw new SuperLineError('INTERNAL', 'This document handle exposes no native Yjs document')
  return doc as YDoc
}
