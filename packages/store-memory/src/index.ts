import { SuperLineError } from '@super-line/core'
import type { ClientStore, Resource, ResourceReplica, ServerStore, StoreChange } from '@super-line/core'

/** A per-writer id (origin). Not security-sensitive — just needs to be unique per client instance. */
const randomId = (): string => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

/**
 * The in-memory, last-writer-wins **server half**. Holds Resources in a `Map`; a write replaces the
 * whole `data`. `clustering: 'relay'` — it does no networking; super-line core relays its Changes across
 * nodes and feeds remote Changes back in via {@link ServerStore.apply}.
 */
export function memoryStoreServer(): ServerStore {
  const resources = new Map<string, Resource>()
  const listeners = new Set<(change: StoreChange) => void>()

  const get = (id: string): Resource => {
    const r = resources.get(id)
    if (!r) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    return r
  }

  return {
    clustering: 'relay',
    read(id) {
      return resources.get(id)
    },
    create(id, data, accessRules) {
      if (resources.has(id)) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      resources.set(id, { id, accessRules, data })
    },
    apply(change) {
      const r = get(change.id)
      r.data = change.update // LWW: the update IS the full new value
      for (const cb of listeners) cb(change) // single fan-out source
    },
    setAccess(id, accessRules) {
      get(id).accessRules = accessRules
    },
    delete(id) {
      resources.delete(id)
    },
    list() {
      return [...resources.keys()]
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

  applyRemote(change: StoreChange): void {
    if (change.origin === this.origin) return // echo-break: our own write
    this.value = change.update // LWW replace
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
