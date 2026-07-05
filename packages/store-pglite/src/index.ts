import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { Change, PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError } from '@super-line/core'
import type { AccessRules, ListOpts, Resource, ResourceSummary, SearchOpts, ServerStore, StoreChange } from '@super-line/core'

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
 *
 * @deprecated The LWW single-document store family is superseded by typed collections (ADR-0006). Use
 * `@super-line/collections-pglite` (`pgliteCollections`, the self-clustering collection backend) with a contract
 * `collections` block; on the client use `client.collection(name)`. The CRDT doc stores (`store-sync*`) are unaffected.
 */
export async function pgliteStoreServer(opts: PgliteStoreOptions): Promise<ServerStore> {
  const table = opts.table ?? 'resources'
  if (!IDENT.test(table)) throw new Error(`Invalid table name: ${table}`)
  const ddl = `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, data jsonb NOT NULL, access jsonb NOT NULL, origin text)`

  // Central Postgres — writes + strong reads + ACL.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  // Reverse ACL index (principal → resource) on the CENTRAL DB, powering list()'s principal filter/count and
  // searchPrincipals(). Kept beside the resource table; the Electric replica never sees it (data-only).
  const aclTable = `${table}_acl`
  const NOW_MS = `(extract(epoch from now())*1000)::bigint`
  // CREATE TABLE / ADD COLUMN are not race-safe: N nodes booting together against the one shared Postgres
  // (the intended clustering:'self' topology) can collide on the catalog insert. The loser sees one of these
  // codes depending on which catalog it collided in: 42P07 (duplicate_table, pg_class), 23505 (unique_violation,
  // a catalog index), or 42710 (duplicate_object, pg_type — the table's implicit row type). All mean a peer won
  // the race and the object now exists — swallow only those.
  const runDdl = async (stmt: string): Promise<void> => {
    try {
      await sql.unsafe(stmt)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== '42P07' && code !== '23505' && code !== '42710') throw err
    }
  }
  await runDdl(ddl)
  await runDdl(`CREATE TABLE IF NOT EXISTS "${aclTable}" (id text NOT NULL, principal text NOT NULL, PRIMARY KEY (id, principal))`)
  // Postgres backfills existing rows with a volatile DEFAULT on ADD COLUMN: legacy rows get the migration time,
  // fresh INSERTs get their own now() (create doesn't list these columns). updated_at is bumped inline on mutate.
  await runDdl(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT ${NOW_MS}, ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT ${NOW_MS}`)
  // Legacy backfill: a fresh _acl over an already-populated resources table. Idempotent (ON CONFLICT); new writes
  // maintain the index going forward, so only seed it when empty.
  const [seeded] = await sql`SELECT 1 FROM ${sql(aclTable)} LIMIT 1`
  if (!seeded) {
    await sql`INSERT INTO ${sql(aclTable)} (id, principal) SELECT id, jsonb_object_keys(access) FROM ${sql(table)} ON CONFLICT DO NOTHING`
  }
  // Rewrite a resource's ACL rows to exactly its current principals. Called inside create/setAccess.
  const syncAcl = async (id: string, accessRules: AccessRules): Promise<void> => {
    await sql`DELETE FROM ${sql(aclTable)} WHERE id = ${id}`
    const principals = Object.keys(accessRules)
    if (principals.length) {
      await sql`INSERT INTO ${sql(aclTable)} ${sql(principals.map((principal) => ({ id, principal })))} ON CONFLICT DO NOTHING`
    }
  }
  // `data` is opaque (unknown); sql.json serializes it to jsonb exactly once (passing pre-stringified text +
  // ::jsonb would double-encode). The cast just satisfies sql.json's strict JSONValue parameter type.
  const asJson = (v: unknown): ReturnType<typeof sql.json> => sql.json(v as Parameters<typeof sql.json>[0])

  // Local in-memory PGlite — the reactive change feed (Electric sync → live.changes). Ephemeral: no dataDir,
  // no shapeKey; it re-syncs from Electric on boot.
  const ownsDb = !opts.db
  const db = (opts.db ?? (await PGlite.create({ extensions: { live, sync: electricSync() } }))) as StoreDb
  await db.exec(ddl)
  // The local replica mirrors central's shape (Electric syncs the whole table incl. created_at/updated_at);
  // without these columns an incoming synced write fails with 42703 (undefined_column).
  await db.exec(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT ${NOW_MS}, ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT ${NOW_MS}`)

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
      await syncAcl(id, accessRules)
    },
    async apply(change) {
      const res = await sql`UPDATE ${sql(table)} SET data = ${asJson(change.update ?? null)}, origin = ${change.origin}, updated_at = ${sql.unsafe(NOW_MS)} WHERE id = ${change.id}`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
    },
    async setAccess(id, accessRules) {
      const res = await sql`UPDATE ${sql(table)} SET access = ${asJson(accessRules)}, updated_at = ${sql.unsafe(NOW_MS)} WHERE id = ${id}`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
      await syncAcl(id, accessRules)
    },
    async delete(id) {
      await sql`DELETE FROM ${sql(table)} WHERE id = ${id}`
      await sql`DELETE FROM ${sql(aclTable)} WHERE id = ${id}`
    },
    async list(opts?: ListOpts): Promise<ResourceSummary[]> {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      const by = sort?.by ?? 'id'
      const dir = sort?.dir === 'desc' ? sql`DESC` : sql`ASC`
      // COLLATE "C" = code-point/binary order (matches store-memory's JS string compare), not locale.
      const orderBy =
        by === 'createdAt'
          ? sql`ORDER BY r.created_at ${dir}`
          : by === 'updatedAt'
            ? sql`ORDER BY r.updated_at ${dir}`
            : by === 'principalCount'
              ? sql`ORDER BY "principalCount" ${dir}`
              : sql`ORDER BY r.id COLLATE "C" ${dir}`
      const rows = await sql`
        SELECT r.id AS id,
          (SELECT count(*)::int FROM ${sql(aclTable)} a WHERE a.id = r.id) AS "principalCount",
          r.created_at AS "createdAt",
          r.updated_at AS "updatedAt"
        FROM ${sql(table)} r
        WHERE 1=1
        ${idContains ? sql`AND strpos(r.id, ${idContains}) > 0` : sql``}
        ${principals?.length ? sql`AND r.id IN (SELECT id FROM ${sql(aclTable)} WHERE principal IN ${sql(principals)})` : sql``}
        ${orderBy}
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
        OFFSET ${offset}`
      return rows.map((r) => ({
        id: r.id as string,
        principalCount: Number(r.principalCount),
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
      }))
    },
    async searchPrincipals(opts: SearchOpts): Promise<string[]> {
      const { query, limit, offset = 0 } = opts
      const rows = await sql`
        SELECT principal FROM ${sql(aclTable)}
        ${query ? sql`WHERE strpos(principal, ${query}) > 0` : sql``}
        GROUP BY principal
        ORDER BY principal COLLATE "C" ASC
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
        OFFSET ${offset}`
      return rows.map((r) => r.principal as string)
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
