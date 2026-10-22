import { DEGENERATE_DATA_COLUMN, planColumns } from '@super-line/core'
import type { CollectionQuery, ColumnPlan, ColumnSpec, Expr, LwwCollectionDef, OrderBy, Scalar, ValueCount } from '@super-line/core'

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

/**
 * Where a filter/order field lives: a typed column, inside a JSON column, nowhere on a validated row, or at a
 * JSON path SQL can't name (`opaque`: the evaluator alone decides it).
 */
type FieldRef = { at: 'scalar'; col: ColumnSpec } | { at: 'json'; col: string; path: string } | { at: 'absent' } | { at: 'opaque' }

/**
 * The SQLite JSON path for dot-path segments, if it reads what the evaluator's property access reads. SQLite takes
 * `$.0` as the key "0", never an array's index 0, and ends a label at `[`, so only identifier segments qualify.
 */
const jsonRef = (col: string, segments: string): FieldRef =>
  segments.split('.').every((segment) => IDENT.test(segment)) ? { at: 'json', col, path: '$.' + segments } : { at: 'opaque' }

function resolveField(t: Table, field: string): FieldRef {
  if (t.plan.degenerate) return jsonRef(DEGENERATE_DATA_COLUMN, field)
  const dot = field.indexOf('.')
  const head = dot === -1 ? field : field.slice(0, dot)
  const col = t.byName.get(head)
  if (!col) return { at: 'absent' } // rows are schema-validated: an undeclared field is never present
  if (col.kind === 'json') return dot === -1 ? { at: 'json', col: col.name, path: '$' } : jsonRef(col.name, field.slice(dot + 1))
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

/** Two-valued: a NOT NULL column already compares to 0/1, and left bare an index can serve it. */
const twoValued = (col: ColumnSpec, sql: string): string => (col.nullable || col.optional ? `COALESCE(${sql}, 0)` : sql)

const TRUE: Compiled = { sql: '1=1', params: [], exact: true }
const FALSE: Compiled = { sql: '1=0', params: [], exact: true }

/** The array element test for `has`: json_each's `type` keeps 1 apart from true and '1'. */
const elementSql = (value: Scalar): { sql: string; params: unknown[] } =>
  value === null
    ? { sql: `e.type = 'null'`, params: [] }
    : typeof value === 'boolean'
      ? { sql: `e.type = '${value}'`, params: [] }
      : typeof value === 'number'
        ? { sql: `e.type IN ('integer', 'real') AND e.value = ?`, params: [value] }
        : { sql: `e.type = 'text' AND e.value = ?`, params: [value] }

/**
 * A `like` pattern as GLOB (case-sensitive, like the evaluator) and an `ilike` one as LIKE (ASCII-only case
 * folding). `%` and every literal translate exactly — `[*]`/`[?]`/`[[]` escape GLOB's own wildcards. Two things
 * only widen, leaving the evaluator to refine: `_` (one UTF-16 code unit in the evaluator, one code point in
 * SQLite) and, for `ilike`, a non-ASCII BMP character, whose case variants SQLite LIKE doesn't fold.
 */
function likeSql(pattern: string, ci: boolean): { pattern: string; exact: boolean } {
  let out = ''
  let exact = true
  for (const ch of pattern) {
    if (ch === '%') out += ci ? '%' : '*'
    else if (ch === '_') {
      out += ci ? '%' : '*'
      exact = false
    } else if (ci && ch.length === 1 && ch.charCodeAt(0) > 0x7f) {
      out += '_'
      exact = false
    } else if (!ci && (ch === '*' || ch === '?' || ch === '[')) out += `[${ch}]`
    else out += ch
  }
  return { pattern: out, exact }
}

/**
 * Compile a filter against a typed table. Exact fragments use two-valued forms only (`IS`/`IS NOT`,
 * `COALESCE(cmp, 0)`) so `not`/`and`/`or` compose without SQL's three-valued NULL logic diverging
 * from the evaluator. Text compares exactly: SQLite's BINARY collation orders UTF-8 bytes, which is
 * code point order, the evaluator's. Returns `null` where not even a superset narrowing is safe
 * (json `neq`, `like` on a json field, `has` on a dot path, …).
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
      if (ref.at === 'opaque') return null
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
        if ((ref.col.kind === 'real' && typeof expr.value === 'number') || (ref.col.kind === 'text' && typeof expr.value === 'string')) {
          return { sql: twoValued(ref.col, `"${ref.col.name}" ${op} ?`), params: [expr.value], exact: true }
        }
        return FALSE // type mismatch / booleans: the evaluator says incomparable ⇒ false
      }
      if (ref.at === 'opaque' || typeof expr.value !== 'number') return null
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
          parts.push(twoValued(ref.col, `"${ref.col.name}" IN (${usable.map(() => '?').join(',')})`))
          params.push(...usable.map(norm))
        }
        if (expr.values.includes(null) && ref.col.nullable) parts.push(`"${ref.col.name}" IS NULL`)
        return parts.length === 0 ? FALSE : { sql: parts.join(' OR '), params, exact: true }
      }
      if (ref.at === 'opaque' || expr.values.some((v) => v === null)) return null // SQL IN (NULL) never matches — let JS decide
      return {
        sql: `COALESCE(json_extract("${ref.col}", ?) IN (${expr.values.map(() => '?').join(',')}), 0)`,
        params: [ref.path, ...expr.values.map(norm)],
        exact: false,
      }
    }
    case 'like':
    case 'ilike': {
      const ref = resolveField(t, expr.field)
      if (ref.at === 'absent') return FALSE
      if (ref.at !== 'scalar') return null
      if (ref.col.kind !== 'text') return FALSE // the evaluator matches strings only
      const p = likeSql(expr.pattern, expr.op === 'ilike')
      const sql = twoValued(ref.col, `"${ref.col.name}" ${expr.op === 'ilike' ? 'LIKE' : 'GLOB'} ?`)
      return { sql, params: [p.pattern], exact: p.exact }
    }
    case 'has': {
      if (expr.field.includes('.')) return null // top-level arrays only
      const ref = resolveField(t, expr.field)
      if (ref.at === 'opaque') return null
      if (ref.at !== 'json') return FALSE // absent, or a scalar column: never an array
      const el = elementSql(expr.value)
      return {
        sql: `json_type("${ref.col}", ?) IS 'array' AND EXISTS (SELECT 1 FROM json_each("${t.name}"."${ref.col}", ?) AS e WHERE ${el.sql})`,
        params: [ref.path, ref.path, ...el.params],
        exact: true,
      }
    }
  }
}

/**
 * Compile ORDER BY, or `null` to sort in JS. Exact for real and text columns: the evaluator sorts
 * nulls/missing last on asc and (via comparator negation) first on desc, ties booleans and mixed
 * types, and orders text by code point — of those, only booleans don't translate.
 */
function compileOrder(t: Table, orderBy: readonly OrderBy[]): string | null {
  const parts: string[] = []
  for (const { field, dir } of orderBy) {
    const ref = resolveField(t, field)
    if (ref.at !== 'scalar' || ref.col.kind === 'integer-bool') return null
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

/** `SELECT COUNT(*) AS n` for `filter`, or `null` when SQL can't answer it exactly (count the snapshot instead). */
export function countSql(t: Table, filter: Expr | undefined, maxParams = Infinity): { sql: string; params: unknown[] } | null {
  if (!filter) return { sql: `SELECT COUNT(*) AS n FROM "${t.name}"`, params: [] }
  const where = compileExpr(t, filter)
  if (!where?.exact || where.params.length > maxParams) return null
  return { sql: `SELECT COUNT(*) AS n FROM "${t.name}" WHERE ${where.sql}`, params: where.params }
}

/**
 * A `GROUP BY` of top-level `field` over `filter`, grouping exactly as core's `countValues`, or `null` when SQL
 * can't answer it exactly. A JSON field goes through `json_each`, which yields an array's elements or a scalar
 * itself; the filter runs in an inner select so json_each's own columns (`id`, `key`, `value`, …) can't shadow
 * the table's.
 */
export function countBySql(
  t: Table,
  field: string,
  filter: Expr | undefined,
  maxParams = Infinity,
): { sql: string; params: unknown[]; decode: (r: Record<string, unknown>) => ValueCount } | null {
  const where = filter ? compileExpr(t, filter) : TRUE
  if (field.includes('.') || !where?.exact || where.params.length + 2 > maxParams) return null
  const ref = resolveField(t, field)
  if (ref.at === 'opaque') return null
  if (ref.at === 'absent') return { sql: `SELECT 0 AS n WHERE 0`, params: [], decode: () => ({ value: null, count: 0 }) }
  if (ref.at === 'scalar') {
    const c = ref.col
    const missing = c.optional ? ` AND "${c.name}" IS NOT NULL` : '' // optional-only: NULL is a missing field
    return {
      sql: `SELECT "${c.name}" AS v, COUNT(*) AS n FROM "${t.name}" WHERE (${where.sql})${missing} GROUP BY "${c.name}"`,
      params: where.params,
      decode: (r) => ({ value: c.kind === 'integer-bool' && r.v !== null ? r.v === 1 : (r.v as Scalar), count: r.n as number }),
    }
  }
  const kind = `CASE WHEN e.type IN ('integer', 'real') THEN 'number' ELSE e.type END`
  return {
    sql:
      `SELECT k, v, COUNT(*) AS n FROM (SELECT DISTINCT f.rid, ${kind} AS k, e.value AS v` +
      ` FROM (SELECT "${t.plan.key}" AS rid, "${ref.col}" AS c FROM "${t.name}" WHERE ${where.sql}) AS f, json_each(f.c, ?) AS e` +
      ` WHERE json_type(f.c, ?) IS NOT 'object' AND e.type NOT IN ('object', 'array')) GROUP BY k, v`,
    params: [...where.params, ref.path, ref.path],
    decode: (r) => ({ value: r.k === 'true' ? true : r.k === 'false' ? false : (r.v as Scalar), count: r.n as number }),
  }
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
