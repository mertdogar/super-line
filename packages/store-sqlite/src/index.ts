import Database from 'better-sqlite3'
import { SuperLineError, removeAtPath } from '@super-line/core'
import type { AccessRules, Resource, ServerStore, StoreChange } from '@super-line/core'

/** Default origin stamped on a server-side co-write (matches the server's `srv.store(ns).write`). */
const SERVER_ORIGIN = 'server'

/** Options for {@link sqliteStoreServer}. */
export interface SqliteStoreOptions {
  /** Path to the SQLite database file (use `:memory:` for an ephemeral store). */
  file: string
  /** Table this store owns; defaults to `resources`. Use distinct tables to share one file across stores. */
  table?: string
}

/** A persisted row: `data` and `access` are JSON text. */
interface Row {
  data: string
  access: string
}

/**
 * The durable, last-writer-wins **server half** — {@link "@super-line/store-memory"}'s `memoryStoreServer`,
 * but backed by SQLite (better-sqlite3) so Resources survive a restart. A write replaces the whole `data`.
 * `clustering: 'relay'` — it does no networking; super-line core relays its Changes across nodes and feeds
 * remote Changes back in via {@link ServerStore.apply}. Pair it with `memoryStoreClient()` on the client.
 */
export function sqliteStoreServer(opts: SqliteStoreOptions): ServerStore {
  const table = opts.table ?? 'resources'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`)

  const db = new Database(opts.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL, access TEXT NOT NULL)`)

  const stmt = {
    get: db.prepare(`SELECT data, access FROM "${table}" WHERE id = ?`),
    has: db.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`),
    insert: db.prepare(`INSERT INTO "${table}" (id, data, access) VALUES (?, ?, ?)`),
    setData: db.prepare(`UPDATE "${table}" SET data = ? WHERE id = ?`),
    setAccess: db.prepare(`UPDATE "${table}" SET access = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM "${table}" WHERE id = ?`),
    list: db.prepare(`SELECT id FROM "${table}"`),
  }

  const listeners = new Set<(change: StoreChange) => void>()

  const readData = (id: string): unknown => {
    const row = stmt.get.get(id) as Row | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  // Single mutation path: persist the replaced LWW value and fan out. Shared by `apply` (relayed/client
  // writes) and the server-side replica's set/update/delete co-writes.
  const commit = (change: StoreChange): void => {
    const res = stmt.setData.run(JSON.stringify(change.update ?? null), change.id)
    if (res.changes === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
    for (const cb of listeners) cb(change)
  }

  return {
    clustering: 'relay',
    read(id): Resource | undefined {
      const row = stmt.get.get(id) as Row | undefined
      if (!row) return undefined
      return { id, accessRules: JSON.parse(row.access) as AccessRules, data: JSON.parse(row.data) }
    },
    create(id, data, accessRules) {
      if (stmt.has.get(id)) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      stmt.insert.run(id, JSON.stringify(data ?? null), JSON.stringify(accessRules))
    },
    apply(change) {
      commit(change) // LWW replace + single fan-out source
    },
    open(id, openOpts) {
      if (!stmt.has.get(id)) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
      const origin = openOpts?.origin ?? SERVER_ORIGIN
      const subs = new Set<() => void>()
      return {
        getSnapshot: () => readData(id),
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
        set: (data) => commit({ id, update: data, origin }),
        update: (partial) => {
          const base = readData(id)
          const merged = typeof base === 'object' && base !== null ? { ...(base as object), ...(partial as object) } : partial
          commit({ id, update: merged, origin })
        },
        delete: (path) => commit({ id, update: removeAtPath(readData(id), path), origin }),
        close: () => {
          for (const off of subs) off()
          subs.clear()
        },
      }
    },
    setAccess(id, accessRules) {
      const res = stmt.setAccess.run(JSON.stringify(accessRules), id)
      if (res.changes === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    },
    delete(id) {
      stmt.delete.run(id)
    },
    list() {
      return (stmt.list.all() as { id: string }[]).map((r) => r.id)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    close() {
      db.close()
    },
  }
}
