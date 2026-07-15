import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError, applyQuery } from '@super-line/core'
import type { SelfCollectionStore, ResolvedRowOp, RowChange, RowTimestamps } from '@super-line/core'

// Central-Postgres wall-clock in epoch ms. Authoritative + node-consistent (self-tier writes hit central once).
// `transaction_timestamp()`, not `clock_timestamp()`: a batch is atomic, so every row it touches must carry the
// SAME stamp (see SelfCollectionStore.apply). clock_timestamp() is volatile *within* a transaction and would hand
// two rows of one batch different values whenever the statements straddle a millisecond.
const NOW_MS = '(extract(epoch from transaction_timestamp())*1000)::bigint'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
// The synthetic single-column key = `collection` + SEP + `id`. `live.changes` keys on ONE column, and U+0001
// (SOH) is a valid Postgres text byte that never appears in a contract collection name (nor, in practice, an id).
const SEP = String.fromCharCode(1)
const encodePk = (n: string, id: string): string => n + SEP + id
const decodePk = (pk: string): { n: string; id: string } => {
  const i = pk.indexOf(SEP)
  return i === -1 ? { n: pk, id: '' } : { n: pk.slice(0, i), id: pk.slice(i + 1) }
}

/** The row shape live.changes selects. Only the KEY (`pk`) is carried on every op — UPDATE/DELETE omit unchanged
 * columns — so the (collection, id) is always decoded from `pk`, never read from separate columns. */
type FeedRow = { pk: string; data: unknown; origin: string | null }
type StoreDb = PGliteWithLive & { sync?: PGliteWithSync['sync'] }

/** Options for {@link pgliteCollections}. */
export interface PgliteCollectionsOptions {
  /** Connection string for the central Postgres — source of truth for writes + strong reads (real Postgres or a PGLiteSocketServer). */
  pgUrl: string
  /** Electric shape endpoint streaming the central table into this node's local replica. Omit to feed the replica manually (tests). */
  electricUrl?: string
  /** Table holding every collection's rows on both central + replica; defaults to `collection_rows`. */
  table?: string
  /** Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `sync`/`electricSync` for real Electric). */
  db?: PGliteWithLive
}

/**
 * The self-clustering SelfCollectionStore (ADR-0006, `clustering: 'self'`) — central Postgres + a per-node
 * Electric-synced replica. Writes + strong reads hit a central Postgres; each node mirrors the row
 * table into an in-memory PGlite replica via **Electric** (one-way) and turns its `live.changes` feed into
 * {@link SelfCollectionStore.onChange}, which core fans to LOCAL subscribers only. Postgres+Electric is the only
 * fan-out infra — no super-line adapter. A write round-trips central PG → Electric → every node's feed; the
 * `origin` column carries attribution through the round-trip. All collections share one table, keyed by the pk.
 */
export async function pgliteCollections(opts: PgliteCollectionsOptions): Promise<SelfCollectionStore> {
  const table = opts.table ?? 'collection_rows'
  if (!IDENT.test(table)) throw new Error(`Invalid table name: ${table}`)
  const ddl = `CREATE TABLE IF NOT EXISTS "${table}" (pk text PRIMARY KEY, collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL, origin text, created_at bigint NOT NULL DEFAULT ${NOW_MS}, updated_at bigint NOT NULL DEFAULT ${NOW_MS})`

  // Central Postgres — writes + strong reads.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  // CREATE TABLE isn't race-safe when N nodes boot together against the one shared Postgres; swallow only the
  // "a peer already created it" catalog codes (see store-pglite for the taxonomy).
  const runDdl = async (stmt: string): Promise<void> => {
    try {
      await sql.unsafe(stmt)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== '42P07' && code !== '23505' && code !== '42710') throw err
    }
  }
  await runDdl(ddl)
  // Migrate a pre-timestamp central table: the volatile default backfills existing rows with the upgrade time.
  await runDdl(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT ${NOW_MS}`)
  await runDdl(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT ${NOW_MS}`)
  const asJson = (v: unknown): ReturnType<typeof sql.json> => sql.json(v as Parameters<typeof sql.json>[0])

  // Local in-memory PGlite — the reactive change feed (Electric → live.changes). Ephemeral; re-syncs on boot.
  const ownsDb = !opts.db
  const db = (opts.db ?? (await PGlite.create({ extensions: { live, sync: electricSync() } }))) as StoreDb
  await db.exec(ddl)

  const changeCbs = new Set<(c: RowChange) => void>()

  // Feed set up BEFORE syncing so streamed-in rows surface as onChange. INSERT/UPDATE → upsert; DELETE → remove.
  // live.changes carries only CHANGED columns + the key, so (collection, id) is always decoded from `pk`; `data`
  // is the new row on INSERT/UPDATE (our writes always set it) and absent on DELETE. RESET re-arrives as inserts.
  const liveSub = await db.live.changes<FeedRow>(`SELECT pk, data, origin FROM "${table}"`, [], 'pk', (changes) => {
    for (const ch of changes) {
      if (ch.__op__ !== 'INSERT' && ch.__op__ !== 'UPDATE' && ch.__op__ !== 'DELETE') continue
      const { n, id } = decodePk(ch.pk)
      const origin = ch.origin ?? ''
      if (ch.__op__ === 'DELETE') {
        for (const cb of changeCbs) cb({ n, k: 'delete', id, origin })
      } else {
        const k = ch.__op__ === 'INSERT' ? 'insert' : 'update'
        for (const cb of changeCbs) cb({ n, k, id, next: ch.data, origin })
      }
    }
  })

  // Incoming Electric sync (read-only central → local replica). shapeKey null = ephemeral (no resume).
  const shape =
    opts.electricUrl && db.sync
      ? await db.sync.syncShapeToTable({ shape: { url: opts.electricUrl, params: { table } }, table, primaryKey: ['pk'], shapeKey: null })
      : undefined

  return {
    clustering: 'self',
    async apply(ops: ResolvedRowOp[], origin: string): Promise<void> {
      // Atomic on central Postgres. A throw rolls the whole transaction back. Changes surface via the Electric
      // feed (onChange) on every node — including this one — so apply returns nothing and fires no onChange;
      // doing either here would double-deliver. That is the `self` half of the contract (ADR-0009).
      await sql.begin(async (tx) => {
        for (const op of ops) {
          const pk = encodePk(op.n, op.id)
          if (op.op === 'insert') {
            const res = await tx`INSERT INTO ${tx(table)} (pk, collection, id, data, origin)
              VALUES (${pk}, ${op.n}, ${op.id}, ${asJson(op.row)}, ${origin}) ON CONFLICT (pk) DO NOTHING`
            if (res.count === 0) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
          } else if (op.op === 'update') {
            const res = await tx`UPDATE ${tx(table)} SET data = ${asJson(op.row)}, origin = ${origin}, updated_at = ${tx.unsafe(NOW_MS)} WHERE pk = ${pk}`
            if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
          } else {
            await tx`DELETE FROM ${tx(table)} WHERE pk = ${pk}` // idempotent
          }
        }
      })
    },
    async snapshot(n, query) {
      // Strong read from central. jsonb::text is parsed here (postgres.js parses jsonb inconsistently across
      // real Postgres vs PGLiteSocketServer). Filter/sort/window applied in JS.
      // ponytail: fetches the whole collection then filters in JS; add a Postgres data->> IR compiler if snapshots get large.
      const rows = await sql`SELECT data::text AS data FROM ${sql(table)} WHERE collection = ${n}`
      return applyQuery(
        rows.map((r) => JSON.parse(r.data as string)),
        query,
      )
    },
    async read(n, id) {
      const rows = await sql`SELECT data::text AS data FROM ${sql(table)} WHERE pk = ${encodePk(n, id)}`
      return rows[0] ? JSON.parse(rows[0].data as string) : undefined
    },
    async rowMeta(n, ids) {
      // Strong read from central — the timestamps never ride the Electric feed (client wire stays row-pure).
      const out: Record<string, RowTimestamps> = {}
      if (ids.length === 0) return out
      const rows = await sql`SELECT id, created_at, updated_at FROM ${sql(table)} WHERE collection = ${n} AND id IN ${sql(ids)}`
      for (const r of rows) out[r.id as string] = { createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }
      return out
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    async close() {
      // sql holds a real network pool — release it even if replica teardown throws.
      try {
        await liveSub.unsubscribe()
        shape?.unsubscribe()
        if (ownsDb) await db.close()
      } finally {
        await sql.end()
      }
    },
  }
}
