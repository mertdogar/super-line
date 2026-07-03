import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { Change, PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError } from '@super-line/core'
import type { AccessRules, Resource, ServerStore, StoreChange } from '@super-line/core'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The feed row shape live.changes selects: the resource id, opaque data, and the echo-break origin. */
type FeedRow = { id: string; data: unknown; origin: string | null }

/** A local PGlite with the `live` extension; `sync` is present when the store creates its own (Electric) replica. */
type StoreDb = PGliteWithLive & { sync?: PGliteWithSync['sync'] }

/** Options for {@link pgliteStoreServer}. */
export interface PgliteStoreOptions {
  /**
   * Connection string for the central Postgres — the source of truth for writes + strong reads + ACL.
   * Accepts a real Postgres URL or a PGLiteSocketServer (both speak pg-wire).
   */
  pgUrl: string
  /**
   * Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`) that streams the central table into this
   * node's local replica. Omit to disable incoming sync — useful for tests/manual feeding of the local replica.
   */
  electricUrl?: string
  /** Table this store owns on both the central DB and the local replica; defaults to `resources`. */
  table?: string
  /**
   * Advanced/testing: supply the local PGlite replica (must have the `live` extension; add `sync`/`electricSync`
   * for real Electric sync). When omitted, an ephemeral in-memory PGlite with `live` + `electricSync` is created.
   */
  db?: PGliteWithLive
}

/**
 * The self-clustering, last-writer-wins **server half** — durable like {@link "@super-line/store-sqlite"}, but
 * its cross-node sync is owned by the store, not super-line's adapter. Writes + strong reads + ACL hit a central
 * Postgres; each node mirrors that table into an in-memory PGlite replica via **Electric** (one-way, read-only)
 * and turns its `live.changes` feed into {@link ServerStore.onChange}/{@link ServerStore.onDelete} — which core
 * fans to LOCAL subscribers only (`clustering: 'self'`). Postgres+Electric is the only fan-out infra. A write
 * round-trips central PG → Electric → every node's `live.changes`; the `origin` column carries echo-break through
 * the round-trip. Pair it with `memoryStoreClient()` on the client.
 */
export async function pgliteStoreServer(opts: PgliteStoreOptions): Promise<ServerStore> {
  const table = opts.table ?? 'resources'
  if (!IDENT.test(table)) throw new Error(`Invalid table name: ${table}`)
  const ddl = `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, data jsonb NOT NULL, access jsonb NOT NULL, origin text)`

  // Central Postgres — writes + strong reads + ACL.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  // CREATE TABLE IF NOT EXISTS is not race-safe: N nodes booting together against the one shared Postgres
  // (the intended clustering:'self' topology) can collide on the catalog insert. The loser sees one of three
  // codes depending on which catalog it collided in: 42P07 (duplicate_table, pg_class), 23505 (unique_violation,
  // a catalog index), or 42710 (duplicate_object, pg_type — the table's implicit row type). All three mean a peer
  // won the race and the table now exists — swallow only those.
  try {
    await sql.unsafe(ddl)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== '42P07' && code !== '23505' && code !== '42710') throw err
  }
  // `data` is opaque (unknown); sql.json serializes it to jsonb exactly once (passing pre-stringified text +
  // ::jsonb would double-encode). The cast just satisfies sql.json's strict JSONValue parameter type.
  const asJson = (v: unknown): ReturnType<typeof sql.json> => sql.json(v as Parameters<typeof sql.json>[0])

  // Local in-memory PGlite — the reactive change feed (Electric sync → live.changes). Ephemeral: no dataDir,
  // no shapeKey; it re-syncs from Electric on boot.
  const ownsDb = !opts.db
  const db = (opts.db ?? (await PGlite.create({ extensions: { live, sync: electricSync() } }))) as StoreDb
  await db.exec(ddl)

  const changeCbs = new Set<(c: StoreChange) => void>()
  const deleteCbs = new Set<(id: string) => void>()

  // Set up the feed BEFORE syncing so rows Electric streams in surface as onChange. insert/update → onChange,
  // delete → onDelete (RESET is a table reload; its rows re-arrive as inserts, so it needs no handling here).
  const liveSub = await db.live.changes<FeedRow>(`SELECT id, data, origin FROM "${table}"`, [], 'id', (changes: Array<Change<FeedRow>>) => {
    for (const ch of changes) {
      if (ch.__op__ === 'DELETE') {
        for (const cb of deleteCbs) cb(ch.id)
      } else if (ch.__op__ === 'INSERT' || ch.__op__ === 'UPDATE') {
        const change: StoreChange = { id: ch.id, update: ch.data, origin: ch.origin ?? '' }
        for (const cb of changeCbs) cb(change)
      }
    }
  })

  // Incoming sync from Electric (read-only Postgres → local replica). shapeKey null = ephemeral (no resume).
  const shape =
    opts.electricUrl && db.sync
      ? await db.sync.syncShapeToTable({
          shape: { url: opts.electricUrl, params: { table } },
          table,
          primaryKey: ['id'],
          shapeKey: null,
        })
      : undefined

  return {
    clustering: 'self',
    model: 'lww',
    async read(id) {
      // jsonb::text yields deterministic JSON text on any pg-wire server (postgres.js parses jsonb
      // inconsistently across real Postgres vs PGLiteSocketServer); parse it once here.
      const rows = await sql`SELECT data::text AS data, access::text AS access FROM ${sql(table)} WHERE id = ${id}`
      const row = rows[0]
      if (!row) return undefined
      return { id, data: JSON.parse(row.data as string), accessRules: JSON.parse(row.access as string) as AccessRules } satisfies Resource
    },
    async create(id, data, accessRules) {
      const res = await sql`INSERT INTO ${sql(table)} (id, data, access, origin)
        VALUES (${id}, ${asJson(data ?? null)}, ${asJson(accessRules)}, ${null})
        ON CONFLICT (id) DO NOTHING`
      if (res.count === 0) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
    },
    async apply(change) {
      const res = await sql`UPDATE ${sql(table)} SET data = ${asJson(change.update ?? null)}, origin = ${change.origin} WHERE id = ${change.id}`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
    },
    async setAccess(id, accessRules) {
      const res = await sql`UPDATE ${sql(table)} SET access = ${asJson(accessRules)} WHERE id = ${id}`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    },
    async delete(id) {
      await sql`DELETE FROM ${sql(table)} WHERE id = ${id}`
    },
    async list() {
      const rows = await sql`SELECT id FROM ${sql(table)}`
      return rows.map((r) => r.id as string)
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    onDelete(cb) {
      deleteCbs.add(cb)
      return () => deleteCbs.delete(cb)
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
