/**
 * The collection query IR — super-line's versioned, backend-agnostic filter language.
 *
 * A {@link CollectionQuery} (filter + orderBy + limit/offset) travels on the wire in a subscribe
 * frame and is the single vocabulary every backend understands. One evaluator ({@link evalExpr})
 * serves three roles: change-feed **routing** on the server (does this changed row match a live
 * subscription's effective filter?), **snapshot** materialization on scan backends (memory), and
 * client-side **re-filtering** when a backend legally over-syncs a superset. SQL backends may
 * compile the same IR to SQL as a snapshot optimization — never for correctness.
 *
 * Values are JSON scalars. A missing field reads as `undefined` and matches nothing (missing ≠ null).
 */

/** A comparable leaf value carried in the IR. */
export type Scalar = string | number | boolean | null

/**
 * A boolean predicate over a row. `field` is a dot path into the row (`'author.name'`). Combine with
 * {@link and}/{@link or}/{@link not}; build leaves with {@link eq}/{@link isIn}/{@link like}/etc.
 */
export type Expr =
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: Scalar }
  | { op: 'in'; field: string; values: Scalar[] }
  | { op: 'like' | 'ilike'; field: string; pattern: string }

/** A sort key: a dot-path field and a direction. */
export interface OrderBy {
  field: string
  dir: 'asc' | 'desc'
}

/**
 * What a client subscribes to. An empty query = the whole (ACL-visible) collection. `orderBy`/`limit`
 * shape the **initial snapshot only** — the live phase streams every filter-matching change, and the
 * consumer owns its window (see PLAN-collections.md, decision 11).
 */
export interface CollectionQuery {
  filter?: Expr
  orderBy?: OrderBy[]
  limit?: number
  offset?: number
}

// ── builders (the ergonomic surface — policies and client filters are written with these) ──

export const and = (...args: Expr[]): Expr => ({ op: 'and', args })
export const or = (...args: Expr[]): Expr => ({ op: 'or', args })
export const not = (arg: Expr): Expr => ({ op: 'not', arg })
export const eq = (field: string, value: Scalar): Expr => ({ op: 'eq', field, value })
export const neq = (field: string, value: Scalar): Expr => ({ op: 'neq', field, value })
export const lt = (field: string, value: Scalar): Expr => ({ op: 'lt', field, value })
export const lte = (field: string, value: Scalar): Expr => ({ op: 'lte', field, value })
export const gt = (field: string, value: Scalar): Expr => ({ op: 'gt', field, value })
export const gte = (field: string, value: Scalar): Expr => ({ op: 'gte', field, value })
export const isIn = (field: string, values: Scalar[]): Expr => ({ op: 'in', field, values })
export const like = (field: string, pattern: string): Expr => ({ op: 'like', field, pattern })
export const ilike = (field: string, pattern: string): Expr => ({ op: 'ilike', field, pattern })

/** AND a set of optional filters (policy filter ∧ client filter), dropping the undefined ones. Empty ⇒ undefined. */
export const andFilters = (...filters: (Expr | undefined)[]): Expr | undefined => {
  const present = filters.filter((f): f is Expr => f !== undefined)
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : and(...present)
}

/**
 * OR a set of optional filters — used to union a connection's subscription filters for change routing.
 * Unlike {@link andFilters}, an `undefined` operand means "match everything", so it **dominates** the union
 * ⇒ `undefined` (match-all). An empty list ⇒ `or()` (matches nothing).
 */
export const orFilters = (filters: (Expr | undefined)[]): Expr | undefined =>
  filters.some((f) => f === undefined) ? undefined : or(...(filters as Expr[]))

// ── evaluation ──

/** Read a dot-path field off a row (fast path for the common no-dot case). Missing ⇒ `undefined`. */
export function getField(row: unknown, path: string): unknown {
  if (row == null || typeof row !== 'object') return undefined
  if (!path.includes('.')) return (row as Record<string, unknown>)[path]
  let cur: unknown = row
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Scalar equality — strict, so a missing field (`undefined`) never equals an explicit `null`. */
const scalarEq = (a: unknown, b: Scalar): boolean => a === b

/** Order two values of the same comparable type; `undefined` ⇒ incomparable (used by range ops, which then fail). */
const compareScalar = (a: unknown, b: Scalar): number | undefined => {
  if (typeof a !== typeof b) return undefined
  if (typeof a === 'number' || typeof a === 'string') return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0
  return undefined
}

// ponytail: compiles the LIKE pattern to a regex per eval; hoist per-query if a hot LIKE filter shows up in profiling.
const likeRegex = (pattern: string, ci: boolean): RegExp => {
  let out = ''
  for (const ch of pattern) {
    if (ch === '%') out += '.*'
    else if (ch === '_') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, ci ? 'i' : '')
}

/** Evaluate a predicate against a row. The single source of truth for routing, snapshots, and client re-filtering. */
export function evalExpr(expr: Expr, row: unknown): boolean {
  switch (expr.op) {
    case 'and':
      return expr.args.every((e) => evalExpr(e, row))
    case 'or':
      return expr.args.some((e) => evalExpr(e, row))
    case 'not':
      return !evalExpr(expr.arg, row)
    case 'eq':
      return scalarEq(getField(row, expr.field), expr.value)
    case 'neq':
      return !scalarEq(getField(row, expr.field), expr.value)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const c = compareScalar(getField(row, expr.field), expr.value)
      if (c === undefined) return false
      return expr.op === 'lt' ? c < 0 : expr.op === 'lte' ? c <= 0 : expr.op === 'gt' ? c > 0 : c >= 0
    }
    case 'in':
      return expr.values.some((v) => scalarEq(getField(row, expr.field), v))
    case 'like':
    case 'ilike': {
      const v = getField(row, expr.field)
      return typeof v === 'string' && likeRegex(expr.pattern, expr.op === 'ilike').test(v)
    }
  }
}

/** Whether a row passes a filter (undefined filter ⇒ always). The routing primitive. */
export const matchesFilter = (filter: Expr | undefined, row: unknown): boolean => !filter || evalExpr(filter, row)

/** Total order for `orderBy`: same-type scalars compare naturally; nulls/undefined/incomparable sort last. */
const compareForSort = (a: unknown, b: unknown): number => {
  const an = a == null
  const bn = b == null
  if (an || bn) return an === bn ? 0 : an ? 1 : -1
  const c = compareScalar(a, b as Scalar)
  return c ?? 0
}

/** Materialize a snapshot: filter → multi-key sort → offset/limit. Used by scan backends and client re-query. */
export function applyQuery<T>(rows: readonly T[], query: CollectionQuery): T[] {
  const out = query.filter ? rows.filter((r) => evalExpr(query.filter as Expr, r)) : rows.slice()
  if (query.orderBy?.length) {
    out.sort((a, b) => {
      for (const { field, dir } of query.orderBy as OrderBy[]) {
        const c = compareForSort(getField(a, field), getField(b, field))
        if (c !== 0) return dir === 'desc' ? -c : c
      }
      return 0
    })
  }
  const offset = query.offset ?? 0
  return query.limit === undefined ? out.slice(offset) : out.slice(offset, offset + query.limit)
}
