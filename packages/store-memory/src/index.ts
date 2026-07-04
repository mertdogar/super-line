import { SuperLineError, removeAtPath } from '@super-line/core'
import type { ClientStore, Resource, ResourceReplica, ServerReplica, ServerStore, StoreChange } from '@super-line/core'

/** A per-writer id (origin). Not security-sensitive — just needs to be unique per client instance. */
const randomId = (): string => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

/** Default origin stamped on a server-side co-write (matches the server's `srv.store(ns).write`). */
const SERVER_ORIGIN = 'server'

/**
 * The in-memory, last-writer-wins **server half**. Holds Resources in a `Map`; a write replaces the
 * whole `data`. `clustering: 'relay'` — it does no networking; super-line core relays its Changes across
 * nodes and feeds remote Changes back in via {@link ServerStore.apply}.
 */
export function memoryStoreServer(): ServerStore {
  const resources = new Map<string, Resource>()
  const listeners = new Set<(change: StoreChange) => void>()
  const meta = new Map<string, { createdAt: number; updatedAt: number }>()
  const acl = new Map<string, Set<string>>() // principal → resource ids (reverse ACL index for list/searchPrincipals)
  const now = (): number => Date.now()

  const indexAdd = (id: string, rules: Resource['accessRules']): void => {
    for (const p of Object.keys(rules)) {
      let s = acl.get(p)
      if (!s) acl.set(p, (s = new Set()))
      s.add(id)
    }
  }
  const indexRemove = (id: string, rules: Resource['accessRules']): void => {
    for (const p of Object.keys(rules)) {
      const s = acl.get(p)
      if (!s) continue
      s.delete(id)
      if (s.size === 0) acl.delete(p)
    }
  }

  const get = (id: string): Resource => {
    const r = resources.get(id)
    if (!r) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    return r
  }

  // Single mutation path: swap the LWW value (the update IS the full new value) and fan out. Used by both
  // `apply` (relayed/client writes) and the server-side replica's set/update/delete co-writes.
  const commit = (change: StoreChange): void => {
    get(change.id).data = change.update
    const m = meta.get(change.id)
    if (m) m.updatedAt = now()
    for (const cb of listeners) cb(change)
  }

  return {
    clustering: 'relay',
    model: 'lww',
    read(id) {
      return resources.get(id)
    },
    create(id, data, accessRules) {
      if (resources.has(id)) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      resources.set(id, { id, accessRules, data })
      meta.set(id, { createdAt: now(), updatedAt: now() })
      indexAdd(id, accessRules)
    },
    apply(change) {
      commit(change) // LWW replace + single fan-out source
    },
    open(id, openOpts) {
      get(id) // NOT_FOUND if absent
      const origin = openOpts?.origin ?? SERVER_ORIGIN
      const subs = new Set<() => void>()
      const snap = (): unknown => resources.get(id)?.data
      return {
        getSnapshot: snap,
        subscribe: (cb) => {
          const wrap = (c: StoreChange): void => {
            if (c.id === id) cb()
          }
          listeners.add(wrap)
          const off = (): void => void listeners.delete(wrap)
          subs.add(off)
          return () => {
            off()
            subs.delete(off)
          }
        },
        // LWW: every write replaces the whole value. delete/update must build a NEW value (read returns the
        // LIVE object + commit swaps by reference), so the prior snapshot is never mutated in place.
        set: (data) => commit({ id, update: data, origin }),
        update: (partial) => {
          const cur = snap()
          const base = typeof cur === 'object' && cur !== null ? (cur as object) : {}
          commit({ id, update: { ...base, ...(partial as object) }, origin })
        },
        delete: (path) => commit({ id, update: removeAtPath(snap(), path), origin }),
        close: () => {
          for (const off of subs) off()
          subs.clear()
        },
      } satisfies ServerReplica
    },
    setAccess(id, accessRules) {
      const r = get(id)
      indexRemove(id, r.accessRules)
      r.accessRules = accessRules
      indexAdd(id, accessRules)
      const m = meta.get(id)
      if (m) m.updatedAt = now()
    },
    delete(id) {
      const r = resources.get(id)
      if (r) indexRemove(id, r.accessRules)
      resources.delete(id)
      meta.delete(id)
    },
    list(opts) {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      let rows = [...resources.values()].map((r) => {
        const m = meta.get(r.id)
        return {
          id: r.id,
          principalCount: Object.keys(r.accessRules).length,
          createdAt: m?.createdAt ?? 0,
          updatedAt: m?.updatedAt ?? 0,
        }
      })
      if (idContains) rows = rows.filter((r) => r.id.includes(idContains))
      if (principals?.length) {
        const allowed = new Set<string>()
        for (const p of principals) for (const rid of acl.get(p) ?? []) allowed.add(rid)
        rows = rows.filter((r) => allowed.has(r.id))
      }
      const by = sort?.by ?? 'id'
      const mul = sort?.dir === 'desc' ? -1 : 1
      rows.sort((a, b) => {
        if (by === 'id') return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * mul
        return (a[by] - b[by]) * mul
      })
      return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit)
    },
    searchPrincipals(opts) {
      const { query, limit, offset = 0 } = opts
      let ps = [...acl.keys()]
      if (query) ps = ps.filter((p) => p.includes(query))
      ps.sort()
      return limit === undefined ? ps.slice(offset) : ps.slice(offset, offset + limit)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/** A last-writer-wins local replica: a plain value cell. A write replaces it and produces a full-value Change. */
class LwwReplica implements ResourceReplica {
  private value: unknown = undefined
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly id: string,
    private readonly origin: string,
  ) {}

  getSnapshot(): unknown {
    return this.value
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  seed(snapshot: unknown): void {
    this.value = snapshot
    this.notify()
  }

  set(data: unknown): StoreChange | null {
    if (Object.is(this.value, data)) return null
    this.value = data
    this.notify()
    return { id: this.id, update: data, origin: this.origin }
  }

  update(partial: unknown): StoreChange | null {
    const base = typeof this.value === 'object' && this.value !== null ? this.value : {}
    return this.set({ ...base, ...(partial as object) })
  }

  // Drop the value at `path` and replace (LWW). `removeAtPath` returns a fresh value, so `set`'s identity
  // guard sees a change and the prior snapshot is never mutated in place.
  delete(path: (string | number)[]): StoreChange | null {
    return this.set(removeAtPath(this.value, path))
  }

  applyRemote(change: StoreChange): void {
    if (change.origin === this.origin) return // echo-break: our own write
    this.value = change.update // LWW replace
    this.notify()
  }

  applyDelete(): void {
    this.notify()
  }
}

/**
 * The in-memory, last-writer-wins **client half**. Each opened Resource is a plain reactive value cell;
 * a write replaces it and emits a full-value Change. `origin` is one per client instance.
 */
export function memoryStoreClient(opts?: { origin?: string }): ClientStore {
  const origin = opts?.origin ?? randomId()
  return {
    origin,
    open(id) {
      return new LwwReplica(id, origin)
    },
  }
}
