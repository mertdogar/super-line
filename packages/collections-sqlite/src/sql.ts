import { DEGENERATE_DATA_COLUMN, planColumns } from '@super-line/core'
import type { CollectionQuery, ColumnPlan, ColumnSpec, Expr, LwwCollectionDef, OrderBy } from '@super-line/core'

// The SQL text of a typed-table row backend, shared by every SQLite engine: better-sqlite3 here, a Durable
// Object's `ctx.storage.sql` in collections-cloudflare (which bundles this file). Pure — it builds statements
// and maps rows, and never runs one, so nothing here may import an engine.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

const sqlType = (kind: ColumnSpec['kind']): string =>
  kind === 'text' ? 'TEXT' : kind === 'real' ? 'REAL' : kind === 'integer-bool' ? 'INTEGER' : 'TEXT'

/** Bind-safe scalar: SQLite engines can't bind booleans, and integer-bool columns store 1/0. */
const norm = (v: unknown): unknown => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

const kindMatches = (kind: ColumnSpec['kind'], v: unknown): boolean =>
  (kind === 'text' && typeof v === 'string') ||
  (kind === 'real' && typeof v === 'number') ||
  (kind === 'integer-bool' && typeof v === 'boolean')

/** One LWW collection's typed table, and the statements a backend runs against it. */
export interface Table {
  name: string
  plan: ColumnPlan
  byName: Map<string, ColumnSpec>
  /** `CREATE TABLE IF NOT EXISTS` — run before {@link driftOf}'s reconcile. */
  create: string
  /** `CREATE INDEX IF NOT EXISTS` per declared index — run after reconcile, which may add their columns. */
  indexes: string[]
  sql: { get: string; has: string; insert: string; update: string; delete: string }
}

export const META_SQL = {
  create: `CREATE TABLE IF NOT EXISTS col_meta (collection TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`,
  get: `SELECT fingerprint FROM col_meta WHERE collection = ?`,
  insert: `INSERT INTO col_meta (collection, fingerprint) VALUES (?, ?)`,
  update: `UPDATE col_meta SET fingerprint = ? WHERE collection = ?`,
}

/** Plan collection `n`'s table (`col_<n>`). Throws on a name, schema or index that can't be a table. */
export function defineTable(n: string, def: LwwCollectionDef): Table {
  if (!IDENT.test(n) || n.length > 60) throw new Error(`invalid collection name '${n}'`)
  const plan = planColumns(def)
  const name = `col_${n}`
  const indexes = (def.indexes ?? []).map((fields, index) => {
    if (fields.length === 0 || fields.some((field) => !plan.columns.some((column) => column.name === field)))
      throw new Error(`invalid index ${index} on '${n}'`)
    return `CREATE INDEX IF NOT EXISTS "${name}_idx_${index}" ON "${name}" (${fields.map((field) => `"${field}"`).join(', ')})`
  })
  const colList = plan.columns.map((c) => `"${c.name}"`).join(', ')
  const setList = [...plan.columns.filter((c) => c.name !== plan.key).map((c) => `"${c.name}" = ?`), `"_sl_updated_at" = ?`].join(', ')
  return {
    name,
    plan,
    byName: new Map(plan.columns.map((c) => [c.name, c])),
    create: createTableSql(name, plan),
    indexes,
    sql: {
      get: `SELECT ${colList} FROM "${name}" WHERE "${plan.key}" = ?`,
      has: `SELECT 1 FROM "${name}" WHERE "${plan.key}" = ?`,
      insert: `INSERT INTO "${name}" (${colList}, "_sl_created_at", "_sl_updated_at") VALUES (${plan.columns.map(() => '?').join(', ')}, ?, ?)`,
      update: `UPDATE "${name}" SET ${setList} WHERE "${plan.key}" = ?`,
      delete: `DELETE FROM "${name}" WHERE "${plan.key}" = ?`,
    },
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

/**
 * The snapshot SELECT. `exact`: the SQL is the whole answer (filter, ORDER BY and LIMIT/OFFSET all pushed);
 * otherwise it only narrows the scan and the caller re-applies the evaluator (`applyQuery`) in JS.
 * `maxParams` is the engine's bound-value limit: a filter that needs more scans the whole table instead.
 */
export function snapshotSql(t: Table, query: CollectionQuery, maxParams = Infinity): { sql: string; params: unknown[]; exact: boolean } {
  let sql = `SELECT ${t.plan.columns.map((c) => `"${c.name}"`).join(', ')} FROM "${t.name}"`
  const params: unknown[] = []
  let where = query.filter ? compileExpr(t, query.filter) : TRUE
  if (where && where.params.length + 2 > maxParams) where = null // + LIMIT/OFFSET
  if (query.filter && where) {
    sql += ` WHERE ${where.sql}`
    params.push(...where.params)
  }
  const order = query.orderBy?.length ? compileOrder(t, query.orderBy) : ''
  if (!where?.exact || order === null) return { sql, params, exact: false }
  if (order) sql += ` ORDER BY ${order}`
  if (query.limit !== undefined || query.offset !== undefined) {
    sql += ` LIMIT ? OFFSET ?`
    params.push(query.limit ?? -1, query.offset ?? 0)
  }
  return { sql, params, exact: true }
}

/** Timestamps of `count` rows by key, bound as `IN (?, …)`. */
export const rowMetaSql = (t: Table, count: number): string =>
  `SELECT "${t.plan.key}" AS id, "_sl_created_at" AS c, "_sl_updated_at" AS u FROM "${t.name}" WHERE "${t.plan.key}" IN (${Array.from({ length: count }, () => '?').join(',')})`

const encode = (col: ColumnSpec, v: unknown): unknown => {
  if (col.kind === 'json') return v === undefined ? null : JSON.stringify(v) // absent ⇔ SQL NULL; null ⇒ 'null'
  if (v === undefined || v === null) return null
  return norm(v)
}

/** Bind values for `sql.insert` before the two timestamps, in column order. */
export function rowParams(t: Table, id: string, row: unknown): unknown[] {
  if (t.plan.degenerate) return [id, JSON.stringify(row)]
  const rec = row as Record<string, unknown>
  return t.plan.columns.map((c) => (c.name === t.plan.key ? id : encode(c, rec[c.name])))
}

/** Every bind value for `sql.update`. */
export function updateParams(t: Table, id: string, row: unknown, ts: number): unknown[] {
  return [...rowParams(t, id, row).filter((_, i) => t.plan.columns[i]!.name !== t.plan.key), ts, id]
}

export function fromRow(t: Table, dbRow: Record<string, unknown>): unknown {
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
 * Drift between the fingerprint stored in `col_meta` and the table's current plan. New SQL-nullable
 * columns are additive (`alter` holds their `ADD COLUMN`s); anything else is `refuse` with the reason —
 * there is no migration framework, and silently guessing would corrupt data.
 */
export function driftOf(t: Table, stored: string): { refuse: string } | { alter: string[] } {
  const old = parseFingerprint(stored)
  const next = parseFingerprint(t.plan.fingerprint)
  if (old.head !== next.head || old.key !== next.key) return { refuse: 'changed its key or shape non-additively' }
  for (const [name, entry] of old.cols) {
    if (next.cols.get(name) !== entry) return { refuse: `changed or removed field '${name}'` }
  }
  const alter: string[] = []
  for (const col of t.plan.columns) {
    if (old.cols.has(col.name)) continue
    if (!col.optional && !col.nullable) return { refuse: `added required field '${col.name}' (existing rows can't be backfilled)` }
    alter.push(`ALTER TABLE "${t.name}" ADD COLUMN "${col.name}" ${sqlType(col.kind)}`)
  }
  return { alter }
}
