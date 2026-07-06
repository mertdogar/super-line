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
      const scratch = new StoreValue<Record<string, unknown>, StoreMode>({}, opts)
      try {
        scratch.applyUpdate(e.sv.encodeState())
        scratch.applyUpdate(delta)
        validate(scratch.getSnapshot())
      } finally {
        scratch.dispose()
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
  private readonly sv: Doc
  private pendingLocal: Uint8Array | null = null
  private readonly off: () => void

  constructor(
    private readonly id: string,
    private readonly origin: string,
    opts: DocOptions | undefined,
  ) {
    this.sv = new StoreValue<Record<string, unknown>, StoreMode>({}, opts)
    this.off = this.sv.onUpdate((update, meta) => {
      if (meta.local) this.pendingLocal = update
    })
  }

  getSnapshot(): unknown {
    return this.sv.getSnapshot()
  }
  subscribe(cb: () => void): () => void {
    return this.sv.subscribe(cb)
  }
  private take(changed: boolean): StoreChange | null {
    const delta = this.pendingLocal
    this.pendingLocal = null
    if (!changed || !delta) return null
    return { id: this.id, update: b64(delta), origin: this.origin }
  }
  set(data: unknown): StoreChange | null {
    this.pendingLocal = null
    return this.take(this.sv.set(data as Record<string, unknown>))
  }
  update(partial: unknown): StoreChange | null {
    this.pendingLocal = null
    return this.take(this.sv.update(partial as Record<string, unknown>))
  }
  delete(path: (string | number)[]): StoreChange | null {
    this.pendingLocal = null
    return this.take(this.sv.set(removeAtPath(this.sv.getSnapshot(), path) as Record<string, unknown>))
  }
  applyRemote(change: StoreChange): void {
    if (change.origin === this.origin) return // echo-break (our own write, already applied locally)
    if (typeof change.update === 'string') this.sv.applyUpdate(fromB64(change.update))
  }
  seed(snapshot: unknown): void {
    if (typeof snapshot === 'string') this.sv.applyUpdate(fromB64(snapshot)) // catch-up = full Yjs state
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
    open(_n, id, docOpts) {
      return new CrdtDocReplica(id, origin, docOpts)
    },
  }
}
