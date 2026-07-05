import Database from 'better-sqlite3'
import { SuperLineError, applyQuery } from '@super-line/core'
import type { CollectionStore, ResolvedRowOp, RowChange, Expr } from '@super-line/core'

/** Options for {@link sqliteCollections}. */
export interface SqliteCollectionsOptions {
  /** Path to the SQLite database file (use `:memory:` for an ephemeral store). */
  file: string
  /** Table that holds every collection's rows; defaults to `collection_rows`. */
  table?: string
}

/** A dot-path field ref → the SQLite json path (`author.name` → `$.author.name`). */
const jsonPath = (field: string): string => '$.' + field

/**
 * Compile a filter to a **superset-safe** SQLite WHERE fragment (bound via `json_extract`) — every row that
 * truly matches the predicate also matches this SQL, so it only narrows the scan; the exact filter/sort/limit
 * is always re-applied in JS with the core evaluator. Returns `null` when a subexpression can't be safely
 * narrowed (`not`/`like`/`ilike`, or a null that SQL can't distinguish), so the caller scans the whole
 * collection and lets JS do the exact work.
 * // ponytail: bails the whole filter on any non-narrowable leaf; push the compilable conjuncts if a hot mixed filter appears.
 */
function compileWhere(expr: Expr | undefined): { sql: string; params: unknown[] } | null {
  if (!expr) return null
  switch (expr.op) {
    case 'and':
    case 'or': {
      if (expr.args.length === 0) return { sql: expr.op === 'and' ? '1=1' : '1=0', params: [] }
      const parts: string[] = []
      const params: unknown[] = []
      for (const arg of expr.args) {
        const c = compileWhere(arg)
        if (!c) return null // a non-narrowable child means we can't safely narrow the whole and/or
        parts.push(`(${c.sql})`)
        params.push(...c.params)
      }
      return { sql: parts.join(expr.op === 'and' ? ' AND ' : ' OR '), params }
    }
    case 'eq':
      return expr.value === null
        ? { sql: `json_extract(data, ?) IS NULL`, params: [jsonPath(expr.field)] }
        : { sql: `json_extract(data, ?) = ?`, params: [jsonPath(expr.field), expr.value] }
    case 'neq':
      if (expr.value === null) return null // rare; let JS handle it
      return { sql: `json_extract(data, ?) IS NOT ?`, params: [jsonPath(expr.field), expr.value] } // null-safe ≠ (keeps missing rows)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (expr.value === null) return null
      const op = expr.op === 'lt' ? '<' : expr.op === 'lte' ? '<=' : expr.op === 'gt' ? '>' : '>='
      return { sql: `json_extract(data, ?) ${op} ?`, params: [jsonPath(expr.field), expr.value] }
    }
    case 'in': {
      if (expr.values.length === 0) return { sql: '1=0', params: [] }
      if (expr.values.some((v) => v === null)) return null // SQL `IN (NULL)` never matches — let JS handle it
      return {
        sql: `json_extract(data, ?) IN (${expr.values.map(() => '?').join(',')})`,
        params: [jsonPath(expr.field), ...expr.values],
      }
    }
    default:
      return null // not / like / ilike → scan the collection, filter in JS
  }
}

/**
 * The durable SQLite CollectionStore — {@link "@super-line/collections-memory"}'s in-memory backend, but
 * rows survive a restart. Every collection's rows live in one table as JSON blobs keyed `(collection, id)`;
 * a batch commits in a single better-sqlite3 transaction (all-or-nothing). Snapshots push the compilable part
 * of the filter to SQL and re-apply the exact query in JS. `clustering: 'relay'` — core relays batches across
 * nodes and re-ingests them through {@link CollectionStore.apply}, so every node is a converged LWW replica.
 */
export function sqliteCollections(opts: SqliteCollectionsOptions): CollectionStore {
  const table = opts.table ?? 'collection_rows'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`)

  const db = new Database(opts.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (
       collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
       PRIMARY KEY (collection, id)
     )`,
  )

  const stmt = {
    get: db.prepare(`SELECT data FROM "${table}" WHERE collection = ? AND id = ?`),
    has: db.prepare(`SELECT 1 FROM "${table}" WHERE collection = ? AND id = ?`),
    insert: db.prepare(`INSERT INTO "${table}" (collection, id, data) VALUES (?, ?, ?)`),
    update: db.prepare(`UPDATE "${table}" SET data = ? WHERE collection = ? AND id = ?`),
    delete: db.prepare(`DELETE FROM "${table}" WHERE collection = ? AND id = ?`),
  }

  const listeners = new Set<(change: RowChange) => void>()

  // One better-sqlite3 transaction = one atomic batch. A throw rolls the whole transaction back.
  const applyTx = db.transaction((ops: ResolvedRowOp[], origin: string): RowChange[] => {
    const changes: RowChange[] = []
    for (const op of ops) {
      if (op.op === 'insert') {
        if (stmt.has.get(op.n, op.id)) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
        stmt.insert.run(op.n, op.id, JSON.stringify(op.row))
        changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
      } else if (op.op === 'update') {
        const prev = stmt.get.get(op.n, op.id) as { data: string } | undefined
        if (!prev) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
        stmt.update.run(JSON.stringify(op.row), op.n, op.id)
        changes.push({ n: op.n, k: 'update', id: op.id, prev: JSON.parse(prev.data), next: op.row, origin })
      } else {
        const prev = stmt.get.get(op.n, op.id) as { data: string } | undefined
        if (!prev) continue // idempotent delete
        stmt.delete.run(op.n, op.id)
        changes.push({ n: op.n, k: 'delete', id: op.id, prev: JSON.parse(prev.data), origin })
      }
    }
    return changes
  })

  return {
    clustering: 'relay',
    apply(ops, origin) {
      const changes = applyTx(ops, origin) // atomic; a throw persisted nothing
      for (const c of changes) for (const cb of listeners) cb(c) // fan out only after the commit
      return changes
    },
    snapshot(n, query) {
      const compiled = compileWhere(query.filter)
      let sql = `SELECT data FROM "${table}" WHERE collection = ?`
      const params: unknown[] = [n]
      if (compiled) {
        sql += ` AND (${compiled.sql})`
        params.push(...compiled.params)
      }
      const rows = (db.prepare(sql).all(...params) as { data: string }[]).map((r) => JSON.parse(r.data))
      return applyQuery(rows, query) // exact filter + sort + window in JS (the evaluator is authoritative)
    },
    read(n, id) {
      const row = stmt.get.get(n, id) as { data: string } | undefined
      return row ? JSON.parse(row.data) : undefined
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
