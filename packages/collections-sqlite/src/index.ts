import Database from 'better-sqlite3'
import { SuperLineError, applyQuery, isCrdtCollection, matchesFilter } from '@super-line/core'
import type { CollectionDef, CollectionQuery, RelayCollectionStore, ResolvedRowOp, RowChange, RowTimestamps } from '@super-line/core'
import { META_SQL, countSql, defineTable, driftOf, fromRow, rowMetaSql, rowParams, snapshotSql, updateParams, type Table } from './sql.js'

/** Options for {@link sqliteCollections}. */
export interface SqliteCollectionsOptions {
  /** Path to the SQLite database file (use `:memory:` for an ephemeral store). */
  file: string
  /** The contract's (post-plugin-merge) `collections` map — each LWW collection gets its own typed table. */
  collections: Record<string, CollectionDef>
}

type Prepared = Table & { stmt: Record<keyof Table['sql'], Database.Statement> }

/**
 * Boot-time drift check (fingerprint in `col_meta`): unchanged ⇒ proceed; new SQL-nullable columns ⇒
 * auto-`ALTER TABLE ADD COLUMN`; anything else refuses to boot. Dev-phase answer: delete the database file.
 */
function reconcile(db: Database.Database, n: string, t: Table): void {
  const row = db.prepare(META_SQL.get).get(n) as { fingerprint: string } | undefined
  if (!row) {
    db.prepare(META_SQL.insert).run(n, t.plan.fingerprint)
    return
  }
  if (row.fingerprint === t.plan.fingerprint) return
  const drift = driftOf(t, row.fingerprint)
  if ('refuse' in drift)
    throw new Error(`sqliteCollections: schema for collection '${n}' ${drift.refuse} — migrate manually or delete the database file`)
  for (const alter of drift.alter) db.exec(alter)
  db.prepare(META_SQL.update).run(t.plan.fingerprint, n)
}

/**
 * The durable SQLite RelayCollectionStore. Every LWW collection declared on the contract gets its own
 * typed table (`col_<name>`): scalar schema fields become real columns, everything else a per-field
 * JSON column (see core's `planColumns`), plus `_sl_created_at`/`_sl_updated_at`. One better-sqlite3
 * transaction spans all tables, so a cross-collection batch stays atomic. Snapshots compile the query
 * IR against real columns — an exactly-compilable query runs entirely in SQL (WHERE + ORDER BY +
 * LIMIT/OFFSET); anything else narrows the scan and re-applies the evaluator in JS (authoritative). `count`
 * runs `COUNT(*)` when the filter compiles exactly.
 * `clustering: 'relay'` — core relays batches across nodes and re-ingests them through `apply`.
 */
export function sqliteCollections(opts: SqliteCollectionsOptions): RelayCollectionStore {
  const db = new Database(opts.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(META_SQL.create)

  const tables = new Map<string, Prepared>()
  for (const [n, def] of Object.entries(opts.collections)) {
    if (isCrdtCollection(def)) continue
    let t: Table
    try {
      t = defineTable(n, def)
    } catch (err) {
      throw new Error(`sqliteCollections: ${(err as Error).message}`)
    }
    db.exec(t.create)
    reconcile(db, n, t)
    for (const index of t.indexes) db.exec(index)
    tables.set(n, { ...t, stmt: Object.fromEntries(Object.entries(t.sql).map(([k, sql]) => [k, db.prepare(sql)])) as Prepared['stmt'] })
  }

  const table = (n: string) => tables.get(n)
  const readRow = (t: Prepared, id: string): unknown => {
    const r = t.stmt.get.get(id) as Record<string, unknown> | undefined
    return r ? fromRow(t, r) : undefined
  }

  const snapshot = (n: string, query: CollectionQuery): unknown[] => {
    const t = table(n)
    if (!t) return [] // undeclared collection: nothing to serve
    const q = snapshotSql(t, query)
    const rows = (db.prepare(q.sql).all(...q.params) as Record<string, unknown>[]).map((r) => fromRow(t, r))
    return q.exact ? rows : applyQuery(rows, query) // non-exact: the evaluator is authoritative
  }

  const listeners = new Set<(change: RowChange) => void>()

  // One better-sqlite3 transaction = one atomic batch across every collection's table.
  const applyTx = db.transaction((ops: ResolvedRowOp[], origin: string): RowChange[] => {
    const changes: RowChange[] = []
    const ts = Date.now() // one wall-clock per batch; createdAt frozen on insert, updatedAt bumps on update
    for (const op of ops) {
      const t = table(op.n)
      if (!t) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${op.n}`)
      if (op.op === 'insert') {
        if (t.stmt.has.get(op.id)) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
        t.stmt.insert.run(...rowParams(t, op.id, op.row), ts, ts)
        changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
      } else if (op.op === 'update') {
        const prev = readRow(t, op.id)
        if (prev === undefined) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
        t.stmt.update.run(...updateParams(t, op.id, op.row, ts))
        changes.push({ n: op.n, k: 'update', id: op.id, prev, next: op.row, origin })
      } else {
        const prev = readRow(t, op.id)
        if (prev === undefined) continue // idempotent delete
        t.stmt.delete.run(op.id)
        changes.push({ n: op.n, k: 'delete', id: op.id, prev, origin })
      }
    }
    return changes
  })

  return {
    clustering: 'relay',
    coordination: 'local',
    apply(ops, origin) {
      const changes = applyTx(ops, origin) // atomic; a throw persisted nothing
      for (const c of changes) for (const cb of listeners) cb(c) // fan out only after the commit
      return changes
    },
    conditionalApply(conditions, ops, origin) {
      let applied = false
      const changes = db.transaction(() => {
        for (const condition of conditions) {
          const t = table(condition.n)
          const row = t ? readRow(t, condition.id) : undefined
          if (row === undefined || !matchesFilter(condition.filter, row)) return []
        }
        applied = true
        return applyTx(ops, origin)
      })()
      if (!applied) return false
      for (const c of changes) for (const cb of listeners) cb(c)
      return true
    },
    snapshot,
    count(n, filter) {
      const t = table(n)
      if (!t) return 0
      const q = countSql(t, filter)
      return q ? (db.prepare(q.sql).get(...q.params) as { n: number }).n : snapshot(n, { filter }).length
    },
    read(n, id) {
      const t = table(n)
      return t ? readRow(t, id) : undefined
    },
    rowMeta(n, ids) {
      const out: Record<string, RowTimestamps> = {}
      const t = table(n)
      if (!t || ids.length === 0) return out
      for (const r of db.prepare(rowMetaSql(t, ids.length)).all(...ids) as { id: string; c: number; u: number }[]) {
        out[r.id] = { createdAt: r.c, updatedAt: r.u }
      }
      return out
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
