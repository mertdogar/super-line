import { SuperLineError } from '@super-line/core'
import type { ClientStore, Resource, ResourceReplica, ServerStore, StoreChange } from '@super-line/core'
import { StoreValue } from '@super-store/store'

// A CRDT Store for super-line, backed by super-store's Yjs engine. The consistency model is *merge*:
// concurrent writes to different fields converge instead of clobbering (the LWW store's failure mode).
// `update` on the wire is an opaque base64 Yjs delta; super-line relays it without parsing. Resources
// are JSON objects (a Yjs doc root). super-store's sync surface — encodeState / applyUpdate / onUpdate —
// does all the CRDT work; we just move bytes and map origins.

type Doc = StoreValue<Record<string, unknown>>

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
const randomId = (): string => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

const SERVER_ORIGIN = 'server'

/**
 * The CRDT **server half**: holds one Yjs doc per Resource. `apply` merges a delta (or sets a full value
 * for a server co-write); every integrated update surfaces through `onChange` so super-line fans the delta
 * out. `clustering: 'relay'` — replicas converge across nodes via super-line's adapter relay.
 */
export function syncStoreServer(): ServerStore {
  interface Entry {
    sv: Doc
    accessRules: Resource['accessRules']
    off: () => void
  }
  const entries = new Map<string, Entry>()
  const cbs = new Set<(change: StoreChange) => void>()
  let currentOrigin = SERVER_ORIGIN // the origin of the in-progress apply; read synchronously by onUpdate

  const get = (id: string): Entry => {
    const e = entries.get(id)
    if (!e) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    return e
  }

  return {
    clustering: 'relay',
    read(id) {
      const e = entries.get(id)
      if (!e) return undefined
      return { id, accessRules: e.accessRules, data: b64(e.sv.encodeState()) } // full state for catch-up
    },
    create(id, data, accessRules) {
      if (entries.has(id)) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      const sv = new StoreValue((data ?? {}) as Record<string, unknown>)
      sv.encodeState() // force-bind before wiring so the initial-bind update isn't fanned as a change
      const off = sv.onUpdate((update) => {
        const origin = currentOrigin
        for (const cb of cbs) cb({ id, update: b64(update), origin })
      })
      entries.set(id, { sv, accessRules, off })
    },
    apply(change) {
      const e = get(change.id)
      currentOrigin = change.origin
      try {
        if (typeof change.update === 'string') e.sv.applyUpdate(fromB64(change.update)) // a peer/relay delta
        else e.sv.set(change.update as Record<string, unknown>) // a full value (server co-write)
      } finally {
        currentOrigin = SERVER_ORIGIN
      }
    },
    setAccess(id, accessRules) {
      get(id).accessRules = accessRules
    },
    delete(id) {
      const e = entries.get(id)
      if (!e) return
      e.off()
      e.sv.dispose()
      entries.delete(id)
    },
    list() {
      return [...entries.keys()]
    },
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
  }
}

/** A CRDT local replica: a super-store `StoreValue`. Local writes produce a delta; remote changes merge. */
class SyncReplica implements ResourceReplica {
  private readonly sv: Doc = new StoreValue<Record<string, unknown>>({})
  private pendingLocal: Uint8Array | null = null
  private readonly off: () => void

  constructor(
    private readonly id: string,
    private readonly origin: string,
  ) {
    // capture the delta our own writes produce; remote merges (local === false) are ignored here
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

  applyRemote(change: StoreChange): void {
    if (change.origin === this.origin) return // echo-break (our own write, already applied locally)
    if (typeof change.update === 'string') this.sv.applyUpdate(fromB64(change.update))
  }

  seed(snapshot: unknown): void {
    if (typeof snapshot === 'string') this.sv.applyUpdate(fromB64(snapshot)) // catch-up = full Yjs state
  }
}

/** The CRDT **client half**: each opened Resource is a reactive super-store doc that merges remote deltas. */
export function syncStoreClient(opts?: { origin?: string }): ClientStore {
  const origin = opts?.origin ?? randomId()
  return {
    origin,
    open(id) {
      return new SyncReplica(id, origin)
    },
  }
}
