import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError, applyQuery, planColumns, isCrdtCollection, DEGENERATE_DATA_COLUMN } from '@super-line/core'
import type {
  SelfCollectionStore,
  ResolvedRowOp,
  RowChange,
  RowTimestamps,
  CollectionDef,
  ColumnPlan,
  ColumnSpec,
  Expr,
} from '@super-line/core'

// Central-Postgres wall-clock in epoch ms. Authoritative + node-consistent (self-tier writes hit central once).
// `transaction_timestamp()`, not `clock_timestamp()`: a batch is atomic, so every row it touches must carry the
// SAME stamp (see SelfCollectionStore.apply). clock_timestamp() is volatile *within* a transaction and would hand
// two rows of one batch different values whenever the statements straddle a millisecond.
const NOW_MS = '(extract(epoch from transaction_timestamp())*1000)::bigint'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Options for {@link pgliteCollections}. */
export interface PgliteCollectionsOptions {
  /** Connection string for the central Postgres — source of truth for writes + strong reads (real Postgres or a PGLiteSocketServer). */
  pgUrl: string
  /** Electric shape endpoint streaming each collection's central table into this node's local replica. Omit to feed the replica manually (tests). */
  electricUrl?: string
  /** The contract's (post-plugin-merge) `collections` map — each LWW collection gets its own typed table. */
  collections: Record<string, CollectionDef>
  /** Prefix for the per-collection tables and the `<prefix>meta` fingerprint table; defaults to `col_`. */
  tablePrefix?: string
  /** Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `sync`/`electricSync` for real Electric). */
  db?: PGliteWithLive
}

type StoreDb = PGliteWithLive & { sync?: PGliteWithSync['sync'] }

const pgType = (kind: ColumnSpec['kind']): string =>
  kind === 'text' ? 'text' : kind === 'real' ? 'double precision' : kind === 'integer-bool' ? 'boolean' : 'jsonb'

interface Table {
  name: string
  plan: ColumnPlan
  byName: Map<string, ColumnSpec>
  /** Column list for reads — json columns cast `::text` so every driver (postgres.js, PGlite) decodes identically. */
  selectList: string
}

const selectListOf = (plan: ColumnPlan): string =>
  [...plan.columns.map((c) => (c.kind === 'json' ? `"${c.name}"::text AS "${c.name}"` : `"${c.name}"`)), '"_sl_origin"'].join(', ')

/** Decode a read/feed record (json columns as JSON text) back into the schema row. */
function decodeRow(plan: ColumnPlan, rec: Record<string, unknown>): unknown {
  if (plan.degenerate) return JSON.parse(rec[DEGENERATE_DATA_COLUMN] as string)
  const row: Record<string, unknown> = {}
  for (const col of plan.columns) {
    const v = rec[col.name]
    if (col.kind === 'json') {
      if (v != null) row[col.name] = typeof v === 'string' ? JSON.parse(v) : v // SQL NULL ⇔ field absent
      continue
    }
    if (v == null) {
      if (col.nullable) row[col.name] = null // optional-only NULL means absent: omit
      continue
    }
    row[col.name] = v
  }
  return row
}

function createTableSql(name: string, plan: ColumnPlan): string {
  const cols = plan.columns.map((c) => {
    const constraint = c.name === plan.key ? ' NOT NULL PRIMARY KEY' : c.optional || c.nullable ? '' : ' NOT NULL'
    return `"${c.name}" ${pgType(c.kind)}${constraint}`
  })
  cols.push('"_sl_origin" text', `"_sl_created_at" bigint NOT NULL DEFAULT ${NOW_MS}`, `"_sl_updated_at" bigint NOT NULL DEFAULT ${NOW_MS}`)
  return `CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')})`
}

const parseFingerprint = (fp: string): { head: string; key: string; cols: Map<string, string> } => {
  const parts = fp.split(';')
  const cols = new Map<string, string>()
  for (const p of parts.slice(2)) cols.set(p.slice(0, p.indexOf(':')), p)
  return { head: parts[0]!, key: parts[1]!, cols }
}

/**
 * Superset-safe WHERE narrowing for central snapshots ($n-parameterized). Never authoritative — the JS
 * evaluator re-applies the exact query — so anything doubtful returns `null` (scan the collection).
 * Scalar columns only; json/dot-path fields, `not`, `like`/`ilike` and text ranges (byte order ≠
 * UTF-16 code-unit order) all fall through to JS.
 */
function compileWhere(t: Table, expr: Expr, params: unknown[]): string | null {
  const scalar = (field: string): ColumnSpec | undefined => {
    if (t.plan.degenerate || field.includes('.')) return undefined
    const col = t.byName.get(field)
    return col && col.kind !== 'json' ? col : undefined
  }
  const matches = (col: ColumnSpec, v: unknown): boolean =>
    (col.kind === 'text' && typeof v === 'string') ||
    (col.kind === 'real' && typeof v === 'number') ||
    (col.kind === 'integer-bool' && typeof v === 'boolean')
  const bind = (v: unknown): string => {
    params.push(v)
    return `$${params.length}`
  }
  switch (expr.op) {
    case 'and':
    case 'or': {
      if (expr.args.length === 0) return expr.op === 'and' ? '1=1' : '1=0'
      const parts: string[] = []
      for (const arg of expr.args) {
        const c = compileWhere(t, arg, params)
        if (!c) {
          if (expr.op === 'or') return null // can't narrow an OR with an uncompilable branch
          continue // an AND just loses the conjunct: still a superset
        }
        parts.push(`(${c})`)
      }
      return parts.length === 0 ? null : parts.join(expr.op === 'and' ? ' AND ' : ' OR ')
    }
    case 'eq': {
      const col = scalar(expr.field)
      if (!col) return null
      if (expr.value === null) return col.nullable ? `"${col.name}" IS NULL` : '1=0'
      return matches(col, expr.value) ? `"${col.name}" IS NOT DISTINCT FROM ${bind(expr.value)}` : '1=0'
    }
    case 'neq': {
      const col = scalar(expr.field)
      if (!col) return null
      if (expr.value === null) return col.nullable ? `"${col.name}" IS NOT NULL` : '1=1'
      return matches(col, expr.value) ? `"${col.name}" IS DISTINCT FROM ${bind(expr.value)}` : '1=1'
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const col = scalar(expr.field)
      if (!col || expr.value === null) return expr.value === null ? '1=0' : null
      if (col.kind === 'real' && typeof expr.value === 'number') {
        const op = expr.op === 'lt' ? '<' : expr.op === 'lte' ? '<=' : expr.op === 'gt' ? '>' : '>='
        return `"${col.name}" ${op} ${bind(expr.value)}`
      }
      return col.kind === 'text' && typeof expr.value === 'string' ? null : '1=0'
    }
    case 'in': {
      if (expr.values.length === 0) return '1=0'
      const col = scalar(expr.field)
      if (!col) return null
      const usable = expr.values.filter((v) => matches(col, v))
      const parts: string[] = []
      if (usable.length > 0) parts.push(`"${col.name}" = ANY(${bind(usable)})`)
      if (expr.values.includes(null) && col.nullable) parts.push(`"${col.name}" IS NULL`)
      return parts.length === 0 ? '1=0' : parts.join(' OR ')
    }
    default:
      return null
  }
}

/**
 * The self-clustering SelfCollectionStore (ADR-0006, `clustering: 'self'`) — central Postgres + a per-node
 * Electric-synced replica. Every LWW collection gets its own typed table (`<prefix><name>`, see core's
 * `planColumns`): writes + strong reads hit central; each node mirrors every table into an in-memory PGlite
 * replica via one **Electric shape per table**, and each table's `live.changes` feed becomes
 * {@link SelfCollectionStore.onChange}. Electric emits only CHANGED columns + the key, so on UPDATE the full
 * row is re-read from the local replica (the change is already applied there) before emitting —
 * `RowChange.next` is always a complete row, which the server's routing and the TanStack adapter both
 * require. Construction DDL is serialized cluster-wide behind a `pg_advisory_xact_lock`, and the
 * `<prefix>meta` fingerprint gates schema drift (additive optional columns auto-ALTER; anything else
 * refuses to boot). Postgres+Electric is the only fan-out infra — no super-line adapter.
 */
export async function pgliteCollections(opts: PgliteCollectionsOptions): Promise<SelfCollectionStore> {
  const prefix = opts.tablePrefix ?? 'col_'
  if (!IDENT.test(prefix)) throw new Error(`Invalid table prefix: ${prefix}`)
  const metaTable = `${prefix}meta`

  const plans = new Map<string, ColumnPlan>()
  for (const [n, def] of Object.entries(opts.collections)) {
    if (isCrdtCollection(def)) continue
    if (!IDENT.test(n) || n.length > 60) throw new Error(`pgliteCollections: invalid collection name '${n}'`)
    if (n === 'meta') throw new Error(`pgliteCollections: collection name 'meta' collides with the '${metaTable}' fingerprint table`)
    plans.set(n, planColumns(def))
  }

  // Central Postgres — writes + strong reads.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  const asJson = (v: unknown): ReturnType<typeof sql.json> => sql.json(v as Parameters<typeof sql.json>[0])

  // All construction DDL + fingerprint reconciliation in ONE transaction behind an advisory lock: N nodes
  // booting concurrently against the shared central Postgres serialize here instead of racing CREATE/ALTER.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS "${metaTable}" (collection text PRIMARY KEY, fingerprint text NOT NULL)`)
    for (const [n, plan] of plans) {
      const tname = `${prefix}${n}`
      await tx.unsafe(createTableSql(tname, plan))
      const rows = await tx.unsafe(`SELECT fingerprint FROM "${metaTable}" WHERE collection = $1`, [n])
      if (rows.length === 0) {
        await tx.unsafe(`INSERT INTO "${metaTable}" (collection, fingerprint) VALUES ($1, $2)`, [n, plan.fingerprint])
        continue
      }
      const stored = (rows[0] as unknown as { fingerprint: string }).fingerprint
      if (stored === plan.fingerprint) continue
      const old = parseFingerprint(stored)
      const next = parseFingerprint(plan.fingerprint)
      const refuse = (why: string): never => {
        throw new Error(`pgliteCollections: schema for collection '${n}' ${why} — migrate manually or reset the central table`)
      }
      if (old.head !== next.head || old.key !== next.key) refuse('changed its key or shape non-additively')
      for (const [name, entry] of old.cols) {
        if (next.cols.get(name) !== entry) refuse(`changed or removed field '${name}'`)
      }
      for (const col of plan.columns) {
        if (old.cols.has(col.name)) continue
        if (!col.optional && !col.nullable) refuse(`added required field '${col.name}' (existing rows can't be backfilled)`)
        await tx.unsafe(`ALTER TABLE "${tname}" ADD COLUMN IF NOT EXISTS "${col.name}" ${pgType(col.kind)}`)
      }
      await tx.unsafe(`UPDATE "${metaTable}" SET fingerprint = $1 WHERE collection = $2`, [plan.fingerprint, n])
    }
  })

  // Local in-memory PGlite — the reactive change feed (Electric → live.changes). Ephemeral; re-syncs on boot.
  const ownsDb = !opts.db
  const db = (opts.db ?? (await PGlite.create({ extensions: { live, sync: electricSync() } }))) as StoreDb

  const tables = new Map<string, Table>()
  for (const [n, plan] of plans) {
    const name = `${prefix}${n}`
    await db.exec(createTableSql(name, plan))
    tables.set(n, { name, plan, byName: new Map(plan.columns.map((c) => [c.name, c])), selectList: selectListOf(plan) })
  }

  const changeCbs = new Set<(c: RowChange) => void>()
  const emit = (c: RowChange): void => {
    for (const cb of changeCbs) cb(c)
  }

  // One live.changes feed per table, wired BEFORE syncing so streamed-in rows surface as onChange.
  // Electric/live.changes carry only CHANGED columns + the key: an INSERT is always a complete row, but an
  // UPDATE may be partial — the full row is re-read from the replica (the change is applied there before the
  // callback fires), keeping RowChange.next whole. A row deleted before the re-read lands just stays silent:
  // its DELETE event follows on the same feed. DELETE carries no columns — prev-less, routing broadcasts it.
  const liveSubs: Array<{ unsubscribe: () => Promise<void> }> = []
  for (const [n, t] of tables) {
    const sub = await db.live.changes<Record<string, unknown>>(
      `SELECT ${t.selectList} FROM "${t.name}"`,
      [],
      t.plan.key,
      (changes) => {
        for (const ch of changes) {
          const op = (ch as { __op__?: string }).__op__
          const id = String(ch[t.plan.key])
          const origin = (ch['_sl_origin'] as string | null | undefined) ?? ''
          if (op === 'DELETE') {
            emit({ n, k: 'delete', id, origin })
          } else if (op === 'INSERT') {
            emit({ n, k: 'insert', id, next: decodeRow(t.plan, ch), origin })
          } else if (op === 'UPDATE') {
            void db.query<Record<string, unknown>>(`SELECT ${t.selectList} FROM "${t.name}" WHERE "${t.plan.key}" = $1`, [id]).then((res) => {
              const full = res.rows[0]
              if (!full) return
              emit({ n, k: 'update', id, next: decodeRow(t.plan, full), origin: (full['_sl_origin'] as string | null) ?? origin })
            })
          }
        }
      },
    )
    liveSubs.push(sub)
  }

  // Incoming Electric sync (read-only central → local replica), one shape per table. shapeKey null = ephemeral.
  const shapes: Array<{ unsubscribe: () => void }> = []
  if (opts.electricUrl && db.sync) {
    for (const t of tables.values()) {
      shapes.push(
        await db.sync.syncShapeToTable({
          shape: { url: opts.electricUrl, params: { table: t.name } },
          table: t.name,
          primaryKey: [t.plan.key],
          shapeKey: null,
        }),
      )
    }
  }

  const table = (n: string): Table | undefined => tables.get(n)
  const encodeRec = (t: Table, id: string, row: unknown, origin: string): Record<string, unknown> => {
    const rec: Record<string, unknown> = { _sl_origin: origin }
    if (t.plan.degenerate) {
      rec[t.plan.key] = id
      rec[DEGENERATE_DATA_COLUMN] = asJson(row)
      return rec
    }
    const src = row as Record<string, unknown>
    for (const col of t.plan.columns) {
      const v = col.name === t.plan.key ? id : src[col.name]
      rec[col.name] = v === undefined ? null : col.kind === 'json' ? asJson(v) : v
    }
    return rec
  }

  return {
    clustering: 'self',
    async apply(ops: ResolvedRowOp[], origin: string): Promise<void> {
      // Atomic on central Postgres. A throw rolls the whole transaction back. Changes surface via the Electric
      // feed (onChange) on every node — including this one — so apply returns nothing and fires no onChange;
      // doing either here would double-deliver. That is the `self` half of the contract (ADR-0009).
      await sql.begin(async (tx) => {
        for (const op of ops) {
          const t = table(op.n)
          if (!t) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${op.n}`)
          if (op.op === 'insert') {
            const rec = encodeRec(t, op.id, op.row, origin)
            const res = await tx`INSERT INTO ${tx(t.name)} ${tx(rec)} ON CONFLICT (${tx(t.plan.key)}) DO NOTHING`
            if (res.count === 0) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
          } else if (op.op === 'update') {
            const { [t.plan.key]: _key, ...rec } = encodeRec(t, op.id, op.row, origin)
            const res = await tx`UPDATE ${tx(t.name)} SET ${tx(rec)}, "_sl_updated_at" = ${tx.unsafe(NOW_MS)} WHERE ${tx(t.plan.key)} = ${op.id}`
            if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
          } else {
            await tx`DELETE FROM ${tx(t.name)} WHERE ${tx(t.plan.key)} = ${op.id}` // idempotent
          }
        }
      })
    },
    async snapshot(n, query) {
      const t = table(n)
      if (!t) return [] // undeclared collection: nothing to serve
      const params: unknown[] = []
      const where = query.filter ? compileWhere(t, query.filter, params) : null
      const rows = await sql.unsafe(`SELECT ${t.selectList} FROM "${t.name}"${where ? ` WHERE ${where}` : ''}`, params as never[])
      return applyQuery(
        rows.map((r) => decodeRow(t.plan, r as Record<string, unknown>)),
        query, // exact filter + sort + window in JS (the evaluator is authoritative)
      )
    },
    async read(n, id) {
      const t = table(n)
      if (!t) return undefined
      const rows = await sql.unsafe(`SELECT ${t.selectList} FROM "${t.name}" WHERE "${t.plan.key}" = $1`, [id])
      return rows[0] ? decodeRow(t.plan, rows[0] as Record<string, unknown>) : undefined
    },
    async rowMeta(n, ids) {
      // Strong read from central — the timestamps never ride the Electric feed (client wire stays row-pure).
      const out: Record<string, RowTimestamps> = {}
      const t = table(n)
      if (!t || ids.length === 0) return out
      const rows = await sql`SELECT ${sql(t.plan.key)} AS id, "_sl_created_at" AS c, "_sl_updated_at" AS u FROM ${sql(t.name)} WHERE ${sql(t.plan.key)} IN ${sql(ids)}`
      for (const r of rows) out[r.id as string] = { createdAt: Number(r.c), updatedAt: Number(r.u) }
      return out
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    async close() {
      // sql holds a real network pool — release it even if replica teardown throws.
      try {
        for (const s of liveSubs) await s.unsubscribe()
        for (const s of shapes) s.unsubscribe()
        if (ownsDb) await db.close()
      } finally {
        await sql.end()
      }
    },
  }
}
