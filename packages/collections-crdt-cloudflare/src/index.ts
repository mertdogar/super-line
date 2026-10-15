import { getLogger } from '@logtape/logtape'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { SuperLineError, isCrdtCollection } from '@super-line/core'
import type { CollectionDef, CrdtCollectionStore, DocOptions } from '@super-line/core'

const log = getLogger(['super-line', 'collections-crdt-cloudflare'])

/** A Durable Object row holds at most 2 MB. Local workerd does not enforce it, so the backend does. */
const MAX_STATE_BYTES = 2_000_000

const TABLE = `CREATE TABLE IF NOT EXISTS _sl_crdt (collection TEXT NOT NULL, id TEXT NOT NULL, state BLOB NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id))`
const UPSERT = `INSERT INTO _sl_crdt (collection, id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (collection, id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
const SORT_COLUMN = { id: 'id', createdAt: 'created_at', updatedAt: 'updated_at' } as const

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

export interface CrdtCloudflareCollectionsOptions {
  /** Coalesce rapid edits into one snapshot write; defaults to 250ms. */
  debounceMs?: number
}

/**
 * The Durable Object SQLite CrdtCollectionStore: {@link crdtMemoryCollections}'s Yjs merge engine, with each
 * `(collection, id)` snapshotted to a row of `_sl_crdt` in the object's own storage. `clustering: 'relay'`.
 *
 * A doc loads on its first use, so a wake costs nothing until a document is touched and building the backend in
 * the object's constructor never throws. Edits are written through per doc after a quiet `debounceMs`; the pending
 * write holds the object out of hibernation that long, and a forced reset (a deploy) loses at most that window.
 * A document whose state outgrows the 2 MB a row holds is refused with an `INTERNAL` error naming it: at create,
 * or — when an edit grows it past the limit — on every later write, while storage keeps the last state that fit.
 *
 * ```ts
 * createSuperLineServer(contract, { ...base, crdtCollections: crdtCloudflareCollections(ctx.storage, contract.collections) })
 * ```
 */
export function crdtCloudflareCollections(
  storage: DurableObjectStorage,
  collections: Record<string, CollectionDef>,
  opts: CrdtCloudflareCollectionsOptions = {},
): CrdtCollectionStore {
  const sql = storage.sql
  const debounceMs = opts.debounceMs ?? 250
  const inner = crdtMemoryCollections()
  const key = (n: string, id: string): string => n + ' ' + id
  const docOptions = (n: string): DocOptions | undefined => {
    const def = collections[n]
    return def && isCrdtCollection(def) ? def.crdt : undefined
  }

  let created = false
  const table = (): void => {
    if (!created) sql.exec(TABLE)
    created = true
  }

  const loaded = new Set<string>()
  let loading = false // a stored doc replays into the engine as one update; it is not a change to fan out
  const load = (n: string, id: string): void => {
    if (loaded.has(key(n, id))) return
    table()
    const row = sql.exec<{ state: ArrayBuffer }>('SELECT state FROM _sl_crdt WHERE collection = ? AND id = ?', n, id).toArray()[0]
    if (!row) return
    loading = true
    try {
      inner.create(n, id, {}, docOptions(n))
      inner.apply({ n, id, update: b64(new Uint8Array(row.state)), origin: 'restore' }, docOptions(n))
    } finally {
      loading = false
    }
    loaded.add(key(n, id))
  }

  const persist = (n: string, id: string): void => {
    const state = fromB64(inner.read(n, id) as string)
    if (state.byteLength > MAX_STATE_BYTES)
      throw new SuperLineError(
        'INTERNAL',
        `crdtCloudflareCollections: document ${n}/${id} is ${state.byteLength} bytes, over the 2 MB a Durable Object row holds — split it into smaller documents`,
      )
    const now = Date.now()
    sql.exec(UPSERT, n, id, state, now, now)
  }

  const refused = new Map<string, unknown>()
  const timers = new Map<string, { n: string; id: string; timer: ReturnType<typeof setTimeout> }>()
  const flush = (n: string, id: string): void => {
    try {
      persist(n, id)
    } catch (err) {
      refused.set(key(n, id), err)
      log.error('Could not write {n}/{id} through: {error}', { n, id, error: err })
    }
  }
  const cancel = (k: string): void => {
    clearTimeout(timers.get(k)?.timer)
    timers.delete(k)
  }
  inner.onChange(({ n, id }) => {
    if (loading) return
    const k = key(n, id)
    cancel(k)
    timers.set(k, {
      n,
      id,
      timer: setTimeout(() => {
        timers.delete(k)
        flush(n, id)
      }, debounceMs),
    })
  })

  return {
    clustering: 'relay',
    read(n, id) {
      load(n, id)
      return inner.read(n, id)
    },
    create(n, id, data, o) {
      load(n, id)
      inner.create(n, id, data, o)
      try {
        persist(n, id) // create fires no change; write it now
      } catch (err) {
        inner.delete(n, id)
        throw err
      }
      loaded.add(key(n, id))
    },
    apply(change, o, validate) {
      load(change.n, change.id)
      const err = refused.get(key(change.n, change.id))
      if (err) throw err
      return inner.apply(change, o, validate)
    },
    delete(n, id) {
      const k = key(n, id)
      cancel(k) // its pending write would find no doc and log a failure
      refused.delete(k)
      loaded.delete(k)
      inner.delete(n, id)
      table()
      sql.exec('DELETE FROM _sl_crdt WHERE collection = ? AND id = ?', n, id)
    },
    list(n, { idContains = '', sort, limit = -1, offset = 0 } = {}) {
      table()
      const order = `${SORT_COLUMN[sort?.by ?? 'id']} ${sort?.dir === 'desc' ? 'DESC' : 'ASC'}`
      return sql
        .exec<{ id: string; created_at: number; updated_at: number }>(
          `SELECT id, created_at, updated_at FROM _sl_crdt WHERE collection = ? AND instr(id, ?) > 0 ORDER BY ${order}, id LIMIT ? OFFSET ?`,
          n,
          idContains,
          limit,
          offset,
        )
        .toArray()
        .map((r) => ({ id: r.id, createdAt: r.created_at, updatedAt: r.updated_at }))
    },
    open(n, id, o) {
      load(n, id)
      return inner.open(n, id, o)
    },
    onChange: (cb) =>
      inner.onChange((change) => {
        if (!loading) cb(change)
      }),
    close() {
      for (const [k, { n, id }] of timers) {
        cancel(k)
        flush(n, id)
      }
    },
  }
}
