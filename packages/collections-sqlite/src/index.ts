import Database from 'better-sqlite3'
import { SuperLineError, applyQuery, planColumns, isCrdtCollection, DEGENERATE_DATA_COLUMN } from '@super-line/core'
import type {
  RelayCollectionStore,
  ResolvedRowOp,
  RowChange,
  RowTimestamps,
  CollectionDef,
  ColumnPlan,
  ColumnSpec,
  Expr,
  OrderBy,
} from '@super-line/core'

/** Options for {@link sqliteCollections}. */
export interface SqliteCollectionsOptions {
  /** Path to the SQLite database file (use `:memory:` for an ephemeral store). */
  file: string
  /** The contract's (post-plugin-merge) `collections` map — each LWW collection gets its own typed table. */
  collections: Record<string, CollectionDef>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

const sqlType = (kind: ColumnSpec['kind']): string =>
  kind === 'text' ? 'TEXT' : kind === 'real' ? 'REAL' : kind === 'integer-bool' ? 'INTEGER' : 'TEXT'

/** Bind-safe scalar: better-sqlite3 can't bind booleans, and integer-bool columns store 1/0. */
const norm = (v: unknown): unknown => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

const kindMatches = (kind: ColumnSpec['kind'], v: unknown): boolean =>
  (kind === 'text' && typeof v === 'string') ||
  (kind === 'real' && typeof v === 'number') ||
  (kind === 'integer-bool' && typeof v === 'boolean')

interface Table {
  name: string
  plan: ColumnPlan
  byName: Map<string, ColumnSpec>
  stmt: {
    get: Database.Statement
    has: Database.Statement
    insert: Database.Statement
    update: Database.Statement
    delete: Database.Statement
  }
}

/** Where a filter/order field lives: a typed column, inside a JSON column, or nowhere on a validated row. */
type FieldRef = { at: 'scalar'; col: ColumnSpec } | { at: 'json'; col: string; path: string } | { at: 'absent' }

function resolveField(t: Table, field: string): FieldRef {
  if (t.plan.degenerate) return { at: 'json', col: DEGENERATE_DATA_COLUMN, path: '$.' + field }
  const dot = field.indexOf('.')
  const head = dot === -1 ? field : field.slice(0, dot)
  const col = t.byName.get(head)
  if (!col) return { at: 'absent' } // rows are schema-validated: an undeclared field is never present
  if (col.kind === 'json') return { at: 'json', col: col.name, path: dot === -1 ? '$' : '$.' + field.slice(dot + 1) }
  return dot === -1 ? { at: 'scalar', col } : { at: 'absent' } // a dot-path into a scalar reads undefined
}

interface Compiled {
  sql: string
  params: unknown[]
  /**
   * `exact`: this SQL reproduces the JS evaluator's result for every row, so the whole query
   * (incl. ORDER BY/LIMIT) may run in SQL with no JS re-check. Non-exact SQL is superset-safe
   * only — it narrows the scan and `applyQuery` remains authoritative (query.ts's contract).
   */
  exact: boolean
}

const TRUE: Compiled = { sql: '1=1', params: [], exact: true }
const FALSE: Compiled = { sql: '1=0', params: [], exact: true }

/**
 * Compile a filter against a typed table. Exact fragments use two-valued forms only (`IS`/`IS NOT`,
 * `COALESCE(cmp, 0)`) so `not`/`and`/`or` compose without SQL's three-valued NULL logic diverging
 * from the evaluator. Text range comparisons and text ORDER BY are never pushed: SQLite compares
 * UTF-8 bytes, JS compares UTF-16 code units, and those orders disagree on astral-plane characters —
 * a superset guarantee can't be made, so JS does them. Returns `null` where not even a superset
 * narrowing is safe (`like`/`ilike`, json `neq`, …).
 */
function compileExpr(t: Table, expr: Expr): Compiled | null {
  switch (expr.op) {
    case 'and':
    case 'or': {
      if (expr.args.length === 0) return expr.op === 'and' ? TRUE : FALSE
      const parts: string[] = []
      const params: unknown[] = []
      let exact = true
      for (const arg of expr.args) {
        const c = compileExpr(t, arg)
        if (!c) {
          if (expr.op === 'or') return null // can't narrow an OR with an uncompilable branch
          exact = false // an AND just loses the conjunct: still a superset, JS refines
          continue
        }
        exact &&= c.exact
        parts.push(`(${c.sql})`)
        params.push(...c.params)
      }
      if (parts.length === 0) return null
      return { sql: parts.join(expr.op === 'and' ? ' AND ' : ' OR '), params, exact }
    }
    case 'not': {
      // NOT of a superset is a subset — it would drop matching rows. Only an exact child negates safely.
      const c = compileExpr(t, expr.arg)
      return c?.exact ? { sql: `NOT (${c.sql})`, params: c.params, exact: true } : null
    }
    case 'eq': {
      const ref = resolveField(t, expr.field)
      if (ref.at === 'absent') return FALSE // undefined === anything (incl. null) is false
      if (ref.at === 'scalar') {
        if (expr.value === null) return ref.col.nullable ? { sql: `"${ref.col.name}" IS NULL`, params: [], exact: true } : FALSE
        if (!kindMatches(ref.col.kind, expr.value)) return FALSE // strict equality: no coercion
        return { sql: `"${ref.col.name}" IS ?`, params: [norm(expr.value)], exact: true }
      }
      const je = `json_extract("${ref.col}", ?)`
      return expr.value === null
        ? { sql: `${je} IS NULL`, params: [ref.path], exact: false } // JSON can't split missing from null
        : { sql: `${je} IS ?`, params: [ref.path, norm(expr.value)], exact: false }
    }
    case 'neq': {
      const ref = resolveField(t, expr.field)
      if (ref.at === 'absent') return TRUE // undefined !== anything
      if (ref.at === 'scalar') {
        if (expr.value === null) return ref.col.nullable ? { sql: `"${ref.col.name}" IS NOT NULL`, params: [], exact: true } : TRUE
        if (!kindMatches(ref.col.kind, expr.value)) return TRUE
        return { sql: `"${ref.col.name}" IS NOT ?`, params: [norm(expr.value)], exact: true }
      }
      return null // json 1/0 vs true/false collide under IS NOT — not even superset-safe
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (expr.value === null) return FALSE // incomparable in the evaluator
      const op = expr.op === 'lt' ? '<' : expr.op === 'lte' ? '<=' : expr.op === 'gt' ? '>' : '>='
      const ref = resolveField(t, expr.field)
      if (ref.at === 'absent') return FALSE
      if (ref.at === 'scalar') {
        if (ref.col.kind === 'real' && typeof expr.value === 'number') {
          return { sql: `COALESCE("${ref.col.name}" ${op} ?, 0)`, params: [expr.value], exact: true }
        }
        if (ref.col.kind === 'text' && typeof expr.value === 'string') return null // byte vs code-unit order
        return FALSE // type mismatch / booleans: the evaluator says incomparable ⇒ false
      }
      if (typeof expr.value !== 'number') return null
      return { sql: `COALESCE(json_extract("${ref.col}", ?) ${op} ?, 0)`, params: [ref.path, expr.value], exact: false }
    }
    case 'in': {
      if (expr.values.length === 0) return FALSE
      const ref = resolveField(t, expr.field)
      if (ref.at === 'absent') return FALSE
      if (ref.at === 'scalar') {
        const usable = expr.values.filter((v) => kindMatches(ref.col.kind, v))
        const parts: string[] = []
        const params: unknown[] = []
        if (usable.length > 0) {
          parts.push(`COALESCE("${ref.col.name}" IN (${usable.map(() => '?').join(',')}), 0)`)
          params.push(...usable.map(norm))
        }
        if (expr.values.includes(null) && ref.col.nullable) parts.push(`"${ref.col.name}" IS NULL`)
        return parts.length === 0 ? FALSE : { sql: parts.join(' OR '), params, exact: true }
      }
      if (expr.values.some((v) => v === null)) return null // SQL IN (NULL) never matches — let JS decide
      return {
        sql: `COALESCE(json_extract("${ref.col}", ?) IN (${expr.values.map(() => '?').join(',')}), 0)`,
        params: [ref.path, ...expr.values.map(norm)],
        exact: false,
      }
    }
    default:
      return null // like / ilike: SQLite LIKE case rules diverge from the evaluator's regex — JS only
  }
}

/**
 * Compile ORDER BY, or `null` to sort in JS. Exact only for real-typed columns: the evaluator sorts
 * nulls/missing last on asc and (via comparator negation) first on desc, ties booleans and mixed
 * types, and orders text by UTF-16 code units — of those, only numbers translate faithfully.
 */
function compileOrder(t: Table, orderBy: readonly OrderBy[]): string | null {
  const parts: string[] = []
  for (const { field, dir } of orderBy) {
    const ref = resolveField(t, field)
    if (ref.at !== 'scalar' || ref.col.kind !== 'real') return null
    parts.push(dir === 'desc' ? `"${ref.col.name}" DESC NULLS FIRST` : `"${ref.col.name}" ASC NULLS LAST`)
  }
  return parts.join(', ')
}

const encode = (col: ColumnSpec, v: unknown): unknown => {
  if (col.kind === 'json') return v === undefined ? null : JSON.stringify(v) // absent ⇔ SQL NULL; null ⇒ 'null'
  if (v === undefined || v === null) return null
  return norm(v)
}

function fromRow(t: Table, dbRow: Record<string, unknown>): unknown {
  if (t.plan.degenerate) return JSON.parse(dbRow[DEGENERATE_DATA_COLUMN] as string)
  const row: Record<string, unknown> = {}
  for (const col of t.plan.columns) {
    const v = dbRow[col.name]
    if (col.kind === 'json') {
      if (v !== null) row[col.name] = JSON.parse(v as string)
      continue
    }
    if (v === null) {
      if (col.nullable) row[col.name] = null // optional-only NULL means absent: omit
      continue
    }
    row[col.name] = col.kind === 'integer-bool' ? v === 1 : v
  }
  return row
}

function createTableSql(name: string, plan: ColumnPlan): string {
  const cols = plan.columns.map((c) => {
    const constraint = c.name === plan.key ? ' NOT NULL PRIMARY KEY' : c.optional || c.nullable ? '' : ' NOT NULL'
    return `"${c.name}" ${sqlType(c.kind)}${constraint}`
  })
  return `CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')}, "_sl_created_at" INTEGER NOT NULL, "_sl_updated_at" INTEGER NOT NULL)`
}

const parseFingerprint = (fp: string): { head: string; key: string; cols: Map<string, string> } => {
  const parts = fp.split(';')
  const cols = new Map<string, string>()
  for (const p of parts.slice(2)) cols.set(p.slice(0, p.indexOf(':')), p)
  return { head: parts[0]!, key: parts[1]!, cols }
}

/**
 * Boot-time drift check (fingerprint in `col_meta`): unchanged ⇒ proceed; new SQL-nullable columns ⇒
 * auto-`ALTER TABLE ADD COLUMN`; anything else refuses to boot — there is no migration framework, and
 * silently guessing would corrupt data. Dev-phase answer: delete the database file.
 */
function reconcile(db: Database.Database, n: string, tableName: string, plan: ColumnPlan): void {
  const row = db.prepare(`SELECT fingerprint FROM col_meta WHERE collection = ?`).get(n) as { fingerprint: string } | undefined
  if (!row) {
    db.prepare(`INSERT INTO col_meta (collection, fingerprint) VALUES (?, ?)`).run(n, plan.fingerprint)
    return
  }
  if (row.fingerprint === plan.fingerprint) return
  const old = parseFingerprint(row.fingerprint)
  const next = parseFingerprint(plan.fingerprint)
  const refuse = (why: string): never => {
    throw new Error(`sqliteCollections: schema for collection '${n}' ${why} — migrate manually or delete the database file`)
  }
  if (old.head !== next.head || old.key !== next.key) refuse('changed its key or shape non-additively')
  for (const [name, entry] of old.cols) {
    if (next.cols.get(name) !== entry) refuse(`changed or removed field '${name}'`)
  }
  for (const col of plan.columns) {
    if (old.cols.has(col.name)) continue
    if (!col.optional && !col.nullable) refuse(`added required field '${col.name}' (existing rows can't be backfilled)`)
    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${sqlType(col.kind)}`)
  }
  db.prepare(`UPDATE col_meta SET fingerprint = ? WHERE collection = ?`).run(plan.fingerprint, n)
}

/**
 * The durable SQLite RelayCollectionStore. Every LWW collection declared on the contract gets its own
 * typed table (`col_<name>`): scalar schema fields become real columns, everything else a per-field
 * JSON column (see core's `planColumns`), plus `_sl_created_at`/`_sl_updated_at`. One better-sqlite3
 * transaction spans all tables, so a cross-collection batch stays atomic. Snapshots compile the query
 * IR against real columns — an exactly-compilable query runs entirely in SQL (WHERE + ORDER BY +
 * LIMIT/OFFSET); anything else narrows the scan and re-applies the evaluator in JS (authoritative).
 * `clustering: 'relay'` — core relays batches across nodes and re-ingests them through `apply`.
 */
export function sqliteCollections(opts: SqliteCollectionsOptions): RelayCollectionStore {
  const db = new Database(opts.file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`CREATE TABLE IF NOT EXISTS col_meta (collection TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`)

  const tables = new Map<string, Table>()
  for (const [n, def] of Object.entries(opts.collections)) {
    if (isCrdtCollection(def)) continue
    if (!IDENT.test(n) || n.length > 60) throw new Error(`sqliteCollections: invalid collection name '${n}'`)
    const plan = planColumns(def)
    const name = `col_${n}`
    db.exec(createTableSql(name, plan))
    reconcile(db, n, name, plan)
    const colList = plan.columns.map((c) => `"${c.name}"`).join(', ')
    const nonKey = plan.columns.filter((c) => c.name !== plan.key)
    const setList = [...nonKey.map((c) => `"${c.name}" = ?`), `"_sl_updated_at" = ?`].join(', ')
    tables.set(n, {
      name,
      plan,
      byName: new Map(plan.columns.map((c) => [c.name, c])),
      stmt: {
        get: db.prepare(`SELECT ${colList} FROM "${name}" WHERE "${plan.key}" = ?`),
        has: db.prepare(`SELECT 1 FROM "${name}" WHERE "${plan.key}" = ?`),
        insert: db.prepare(
          `INSERT INTO "${name}" (${colList}, "_sl_created_at", "_sl_updated_at") VALUES (${plan.columns.map(() => '?').join(', ')}, ?, ?)`,
        ),
        update: db.prepare(`UPDATE "${name}" SET ${setList} WHERE "${plan.key}" = ?`),
        delete: db.prepare(`DELETE FROM "${name}" WHERE "${plan.key}" = ?`),
      },
    })
  }

  const table = (n: string): Table | undefined => tables.get(n)
  const readRow = (t: Table, id: string): unknown => {
    const r = t.stmt.get.get(id) as Record<string, unknown> | undefined
    return r ? fromRow(t, r) : undefined
  }
  const rowValues = (t: Table, id: string, row: unknown): unknown[] => {
    if (t.plan.degenerate) return [id, JSON.stringify(row)]
    const rec = row as Record<string, unknown>
    return t.plan.columns.map((c) => (c.name === t.plan.key ? id : encode(c, rec[c.name])))
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
        t.stmt.insert.run(...rowValues(t, op.id, op.row), ts, ts)
        changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
      } else if (op.op === 'update') {
        const prev = readRow(t, op.id)
        if (prev === undefined) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
        const values = rowValues(t, op.id, op.row)
        t.stmt.update.run(...values.filter((_, i) => t.plan.columns[i]!.name !== t.plan.key), ts, op.id)
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
    apply(ops, origin) {
      const changes = applyTx(ops, origin) // atomic; a throw persisted nothing
      for (const c of changes) for (const cb of listeners) cb(c) // fan out only after the commit
      return changes
    },
    snapshot(n, query) {
      const t = table(n)
      if (!t) return [] // undeclared collection: nothing to serve
      let sql = `SELECT ${t.plan.columns.map((c) => `"${c.name}"`).join(', ')} FROM "${t.name}"`
      const params: unknown[] = []
      const where = query.filter ? compileExpr(t, query.filter) : TRUE
      if (query.filter && where) {
        sql += ` WHERE ${where.sql}`
        params.push(...where.params)
      }
      const order = query.orderBy?.length ? compileOrder(t, query.orderBy) : ''
      if (where?.exact && order !== null) {
        if (order) sql += ` ORDER BY ${order}`
        if (query.limit !== undefined || query.offset !== undefined) {
          sql += ` LIMIT ? OFFSET ?`
          params.push(query.limit ?? -1, query.offset ?? 0)
        }
        return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => fromRow(t, r))
      }
      const rows = (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => fromRow(t, r))
      return applyQuery(rows, query) // exact filter + sort + window in JS (the evaluator is authoritative)
    },
    read(n, id) {
      const t = table(n)
      return t ? readRow(t, id) : undefined
    },
    rowMeta(n, ids) {
      const out: Record<string, RowTimestamps> = {}
      const t = table(n)
      if (!t || ids.length === 0) return out
      const q = `SELECT "${t.plan.key}" AS id, "_sl_created_at" AS c, "_sl_updated_at" AS u FROM "${t.name}" WHERE "${t.plan.key}" IN (${ids.map(() => '?').join(',')})`
      for (const r of db.prepare(q).all(...ids) as { id: string; c: number; u: number }[]) {
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
