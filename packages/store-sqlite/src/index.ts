import Database from 'better-sqlite3'
import { SuperLineError, removeAtPath } from '@super-line/core'
import type { AccessRules, ListOpts, Resource, ResourceSummary, SearchOpts, ServerStore, StoreChange } from '@super-line/core'

/** DB-clock epoch-ms expression, inlined into UPDATEs so `updated_at` uses the store's clock (no trigger). */
const NOW_MS = "unixepoch('subsec') * 1000"

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
 *
 * @deprecated The LWW single-document store family is superseded by typed collections (ADR-0006). Use
 * `@super-line/collections-sqlite` (`sqliteCollections`) with a contract `collections` block; on the client
 * use `client.collection(name)`. The CRDT doc stores (`@super-line/store-sync*`) are unaffected.
 */
export function sqliteStoreServer(opts: SqliteStoreOptions): ServerStore {
  const table = opts.table ?? 'resources'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`)

  const acl = `${table}_acl`

  const db = new Database(opts.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  // Fresh table gets the timestamp columns with a DB-clock default; legacy tables are migrated below.
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (
       id TEXT PRIMARY KEY, data TEXT NOT NULL, access TEXT NOT NULL,
       created_at INTEGER NOT NULL DEFAULT (${NOW_MS}),
       updated_at INTEGER NOT NULL DEFAULT (${NOW_MS})
     )`,
  )
  // Legacy migration: a pre-existing table lacks the timestamp columns. sqlite forbids a volatile DEFAULT on
  // ADD COLUMN, so add them nullable then backfill the existing rows to migration time (non-null thereafter).
  const cols = new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('created_at')) db.exec(`ALTER TABLE "${table}" ADD COLUMN created_at INTEGER`)
  if (!cols.has('updated_at')) db.exec(`ALTER TABLE "${table}" ADD COLUMN updated_at INTEGER`)
  db.exec(`UPDATE "${table}" SET created_at = ${NOW_MS} WHERE created_at IS NULL`)
  db.exec(`UPDATE "${table}" SET updated_at = ${NOW_MS} WHERE updated_at IS NULL`)

  // Reverse ACL index: one row per (resource, principal), for principal filtering + searchPrincipals.
  db.exec(`CREATE TABLE IF NOT EXISTS "${acl}" (resource_id TEXT, principal TEXT, PRIMARY KEY(resource_id, principal))`)
  db.exec(`CREATE INDEX IF NOT EXISTS "${acl}_principal" ON "${acl}"(principal)`)
  // Boot backfill for a legacy/empty index: derive it from each Resource's access JSON.
  const aclEmpty = (db.prepare(`SELECT 1 FROM "${acl}" LIMIT 1`).get() as unknown) === undefined
  if (aclEmpty) db.exec(`INSERT INTO "${acl}" SELECT "${table}".id, je.key FROM "${table}", json_each("${table}".access) je`)

  const stmt = {
    get: db.prepare(`SELECT data, access FROM "${table}" WHERE id = ?`),
    has: db.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`),
    insert: db.prepare(`INSERT INTO "${table}" (id, data, access) VALUES (?, ?, ?)`),
    setData: db.prepare(`UPDATE "${table}" SET data = ?, updated_at = ${NOW_MS} WHERE id = ?`),
    setAccess: db.prepare(`UPDATE "${table}" SET access = ?, updated_at = ${NOW_MS} WHERE id = ?`),
    delete: db.prepare(`DELETE FROM "${table}" WHERE id = ?`),
    aclInsert: db.prepare(`INSERT INTO "${acl}" (resource_id, principal) VALUES (?, ?)`),
    aclClear: db.prepare(`DELETE FROM "${acl}" WHERE resource_id = ?`),
  }

  // ACL-index maintenance runs in the same transaction as the row write it mirrors.
  const createTx = db.transaction((id: string, data: string, access: string, principals: string[]) => {
    stmt.insert.run(id, data, access)
    for (const p of principals) stmt.aclInsert.run(id, p)
  })
  const setAccessTx = db.transaction((id: string, access: string, principals: string[]): number => {
    const res = stmt.setAccess.run(access, id)
    if (res.changes === 0) return 0
    stmt.aclClear.run(id)
    for (const p of principals) stmt.aclInsert.run(id, p)
    return 1
  })
  const deleteTx = db.transaction((id: string) => {
    stmt.delete.run(id)
    stmt.aclClear.run(id)
  })

  const SORT_COL: Record<NonNullable<ListOpts['sort']>['by'], string> = {
    id: 'id',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    principalCount: 'principalCount',
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
    model: 'lww',
    read(id): Resource | undefined {
      const row = stmt.get.get(id) as Row | undefined
      if (!row) return undefined
      return { id, accessRules: JSON.parse(row.access) as AccessRules, data: JSON.parse(row.data) }
    },
    create(id, data, accessRules) {
      if (stmt.has.get(id)) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      createTx(id, JSON.stringify(data ?? null), JSON.stringify(accessRules), Object.keys(accessRules))
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
      if (setAccessTx(id, JSON.stringify(accessRules), Object.keys(accessRules)) === 0)
        throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    },
    delete(id) {
      deleteTx(id)
    },
    list(opts): ResourceSummary[] {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      const where: string[] = []
      const params: unknown[] = []
      if (idContains !== undefined) {
        where.push(`instr(id, ?) > 0`) // literal substring (case-sensitive, matches JS .includes) — NOT LIKE, whose %/_ are wildcards
        params.push(idContains)
      }
      if (principals?.length) {
        where.push(`id IN (SELECT resource_id FROM "${acl}" WHERE principal IN (${principals.map(() => '?').join(',')}))`)
        params.push(...principals)
      }
      const by = SORT_COL[sort?.by ?? 'id']
      const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC'
      const sql =
        `SELECT id, (SELECT COUNT(*) FROM "${acl}" WHERE resource_id = "${table}".id) AS principalCount,` +
        ` created_at AS createdAt, updated_at AS updatedAt FROM "${table}"` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${by} ${dir}${by === 'id' ? '' : ', id ASC'} LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...params, limit ?? -1, offset) as ResourceSummary[] // sqlite LIMIT -1 = unbounded
    },
    searchPrincipals(opts: SearchOpts): string[] {
      const { query, limit, offset = 0 } = opts
      const rows = db
        .prepare(
          `SELECT DISTINCT principal FROM "${acl}"` +
            (query !== undefined ? ` WHERE instr(principal, ?) > 0` : '') +
            ` ORDER BY principal ASC LIMIT ? OFFSET ?`,
        )
        .all(...(query !== undefined ? [query] : []), limit ?? -1, offset) as { principal: string }[]
      return rows.map((r) => r.principal)
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
