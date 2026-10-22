import { SuperLineError, applyQuery, isCrdtCollection, matchesFilter } from '@super-line/core'
import type {
  CollectionDef,
  CollectionQuery,
  LwwCollectionDef,
  RelayCollectionStore,
  ResolvedRowOp,
  RowChange,
  RowTimestamps,
} from '@super-line/core'
import {
  META_SQL,
  countSql,
  defineTable,
  driftOf,
  fromRow,
  rowMetaSql,
  rowParams,
  snapshotSql,
  updateParams,
  type Table,
} from '../../collections-sqlite/src/sql.js'

export { READ_ONLY_MESSAGE, syncedSql } from './synced-sql.js'
export { remoteRows } from './remote-rows.js'
export type { RemoteRowsOptions, RemoteRowsStorage, RemoteRowsStore, RemoteSource } from './remote-rows.js'
export type { RemoteChange, RemoteChanges, RemotePush, RemoteRow, SyncedSql, SyncedSqlOptions } from './synced-sql.js'
export type { Outcome, QueryOptions, Result, Statement, Value } from './contract.js'

/** A Durable Object query binds at most 100 values. */
const MAX_PARAMS = 100
/** A Durable Object table holds at most 100 columns; two are the row timestamps. */
const MAX_COLUMNS = 98

/**
 * The Durable Object SQLite RelayCollectionStore: every LWW collection on the contract gets its own typed table
 * (`col_<name>`) in the object's own storage, exactly as `sqliteCollections` lays it out, and one
 * `transactionSync` spans all of them, so a cross-collection batch stays atomic.
 *
 * Opens lazily, on the first operation, so building it in the object's constructor never throws (a throw there
 * resets the object). A collection that can't open — its schema drifted non-additively, or it plans more than 98
 * columns — fails only its own operations, with an `INTERNAL` error that names it and the fix; the rest keep
 * working. Additive drift (new optional fields) is altered in, as with `sqliteCollections`.
 *
 * ```ts
 * createSuperLineServer(contract, { ...base, collections: cloudflareCollections(ctx.storage, contract.collections) })
 * ```
 */
export function cloudflareCollections(storage: DurableObjectStorage, collections: Record<string, CollectionDef>): RelayCollectionStore {
  const sql = storage.sql
  const rows = (query: string, ...params: unknown[]) => Array.from(sql.exec(query, ...params)) as Record<string, unknown>[]

  const openTable = (n: string, def: LwwCollectionDef): Table => {
    const t = defineTable(n, def)
    if (t.plan.columns.length > MAX_COLUMNS)
      throw new Error(`plans ${t.plan.columns.length} columns; a Durable Object table holds ${MAX_COLUMNS} besides the row timestamps`)
    sql.exec(t.create)
    const stored = rows(META_SQL.get, n)[0]?.fingerprint as string | undefined
    if (stored === undefined) sql.exec(META_SQL.insert, n, t.plan.fingerprint)
    else if (stored !== t.plan.fingerprint) {
      const drift = driftOf(t, stored)
      if ('refuse' in drift)
        throw new Error(`schema ${drift.refuse} — rename the collection, or migrate table "${t.name}" and its col_meta row in code`)
      for (const alter of drift.alter) sql.exec(alter)
      sql.exec(META_SQL.update, t.plan.fingerprint, n)
    }
    for (const index of t.indexes) sql.exec(index)
    return t
  }

  let tables: Map<string, Table | SuperLineError> | undefined
  const open = (): Map<string, Table | SuperLineError> => {
    if (tables) return tables
    sql.exec(META_SQL.create)
    tables = new Map()
    for (const [n, def] of Object.entries(collections)) {
      if (isCrdtCollection(def)) continue
      try {
        tables.set(n, openTable(n, def))
      } catch (err) {
        tables.set(n, new SuperLineError('INTERNAL', `cloudflareCollections: collection '${n}' is unusable: ${(err as Error).message}`))
      }
    }
    return tables
  }
  const table = (n: string): Table | undefined => {
    const t = open().get(n)
    if (t instanceof SuperLineError) throw t
    return t
  }
  const readRow = (t: Table, id: string): unknown => {
    const r = rows(t.sql.get, id)[0]
    return r ? fromRow(t, r) : undefined
  }

  const snapshot = (n: string, query: CollectionQuery): unknown[] => {
    const t = table(n)
    if (!t) return [] // undeclared collection: nothing to serve
    const q = snapshotSql(t, query, MAX_PARAMS)
    const found = rows(q.sql, ...q.params).map((r) => fromRow(t, r))
    return q.exact ? found : applyQuery(found, query) // non-exact: the evaluator is authoritative
  }

  const listeners = new Set<(change: RowChange) => void>()
  const emit = (changes: RowChange[]) => {
    for (const c of changes) for (const cb of listeners) cb(c) // fan out only after the commit
  }

  // Runs inside the caller's transactionSync: a throw rolls the whole batch back.
  const applyOps = (ops: ResolvedRowOp[], origin: string): RowChange[] => {
    const changes: RowChange[] = []
    const ts = Date.now() // one wall-clock per batch; createdAt frozen on insert, updatedAt bumps on update
    for (const op of ops) {
      const t = table(op.n)
      if (!t) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${op.n}`)
      if (op.op === 'insert') {
        if (rows(t.sql.has, op.id).length > 0) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
        sql.exec(t.sql.insert, ...rowParams(t, op.id, op.row), ts, ts)
        changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
      } else if (op.op === 'update') {
        const prev = readRow(t, op.id)
        if (prev === undefined) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
        sql.exec(t.sql.update, ...updateParams(t, op.id, op.row, ts))
        changes.push({ n: op.n, k: 'update', id: op.id, prev, next: op.row, origin })
      } else {
        const prev = readRow(t, op.id)
        if (prev === undefined) continue // idempotent delete
        sql.exec(t.sql.delete, op.id)
        changes.push({ n: op.n, k: 'delete', id: op.id, prev, origin })
      }
    }
    return changes
  }

  return {
    clustering: 'relay',
    coordination: 'local',
    apply(ops, origin) {
      const changes = storage.transactionSync(() => applyOps(ops, origin))
      emit(changes)
      return changes
    },
    conditionalApply(conditions, ops, origin) {
      const changes = storage.transactionSync(() => {
        for (const condition of conditions) {
          const t = table(condition.n)
          const row = t ? readRow(t, condition.id) : undefined
          if (row === undefined || !matchesFilter(condition.filter, row)) return undefined
        }
        return applyOps(ops, origin)
      })
      if (!changes) return false
      emit(changes)
      return true
    },
    snapshot,
    count(n, filter) {
      const t = table(n)
      if (!t) return 0
      const q = countSql(t, filter, MAX_PARAMS)
      return q ? (rows(q.sql, ...q.params)[0]!.n as number) : snapshot(n, { filter }).length
    },
    read(n, id) {
      const t = table(n)
      return t ? readRow(t, id) : undefined
    },
    rowMeta(n, ids) {
      const out: Record<string, RowTimestamps> = {}
      const t = table(n)
      if (!t) return out
      for (let i = 0; i < ids.length; i += MAX_PARAMS) {
        const chunk = ids.slice(i, i + MAX_PARAMS)
        for (const r of rows(rowMetaSql(t, chunk.length), ...chunk)) {
          out[r.id as string] = { createdAt: r.c as number, updatedAt: r.u as number }
        }
      }
      return out
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
