import { createClient } from '@libsql/client'
import { syncStoreServer } from '@super-line/store-sync'
import type { DocOptions } from '@super-line/store-sync'
import type { AccessRules, ResourceSummary, ServerStore } from '@super-line/core'

export interface LibsqlSyncStoreOptions {
  /** libsql URL: `file:x.db`, `:memory:`, `libsql://` (Turso) or `http://`/`https://` (sqld). */
  url: string
  /** Auth token for Turso Cloud. */
  authToken?: string
  /** Table this store owns; defaults to `resources`. Validated `/^[A-Za-z_][A-Za-z0-9_]*$/`. */
  table?: string
  /** Coalesce rapid edits into one snapshot write; defaults to 250ms. */
  debounceMs?: number
  /** Per-resource super-store config; MUST match the client's (the store-sync rule). */
  resolveOptions?: (id: string) => DocOptions | undefined
}

/**
 * Durable CRDT **server half**: `syncStoreServer`'s Yjs merge engine, snapshotted per Resource to a shared
 * libsql so state survives a restart. A thin wrapper — persistence is an extra `onChange` subscriber that
 * debounces a full-state upsert; the hot path (`apply`) stays synchronous and relay-safe. Async factory:
 * it rehydrates every Resource (history-preserving `applyUpdate`) before returning a ready store.
 *
 * `list`/`searchPrincipals` are SQL-backed (index-backed junction table `"<table>_acl"` + `created_at`/
 * `updated_at` columns), so filter/sort/paginate happen in the DB rather than in memory.
 */
export async function libsqlSyncStore(opts: LibsqlSyncStoreOptions): Promise<ServerStore> {
  const table = opts.table ?? 'resources'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`)
  const aclTable = `${table}_acl`
  const debounceMs = opts.debounceMs ?? 250
  const now = (): number => Date.now()

  const client = createClient({ url: opts.url, authToken: opts.authToken })
  await client.execute(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, state TEXT NOT NULL, access TEXT NOT NULL)`)
  // created_at/updated_at: ADD COLUMN nullable (ignore duplicate-column on reopen), then backfill legacy rows.
  for (const col of ['created_at', 'updated_at']) {
    try {
      await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${col} INTEGER`)
    } catch {
      // column already exists
    }
  }
  await client.execute({
    sql: `UPDATE "${table}" SET created_at = COALESCE(created_at, ?), updated_at = COALESCE(updated_at, ?) WHERE created_at IS NULL OR updated_at IS NULL`,
    args: [now(), now()],
  })
  // Reverse ACL index (principal → resource) for the principal filter + searchPrincipals; INDEX on principal.
  await client.execute(`CREATE TABLE IF NOT EXISTS "${aclTable}" (resource_id TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (resource_id, principal))`)
  await client.execute(`CREATE INDEX IF NOT EXISTS "${table}_acl_principal" ON "${aclTable}" (principal)`)
  // Backfill the junction from each row's access JSON (idempotent; covers legacy pre-index rows on boot).
  await client.execute(`INSERT OR IGNORE INTO "${aclTable}" (resource_id, principal) SELECT "${table}".id, json_each.key FROM "${table}", json_each("${table}".access)`)

  const inner = syncStoreServer({ resolveOptions: opts.resolveOptions })
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const snapshot = async (id: string): Promise<void> => {
    const res = await inner.read(id)
    if (!res) return
    await client.execute({
      sql: `INSERT INTO "${table}" (id, state, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      args: [id, res.data as string, JSON.stringify(res.accessRules), now(), now()],
    })
  }

  const cancel = (id: string): void => {
    const t = timers.get(id)
    if (!t) return
    clearTimeout(t)
    timers.delete(id)
  }

  // Rehydrate before wiring the persistence subscriber, so replayed state (already in the DB) isn't re-persisted.
  const { rows } = await client.execute(`SELECT id, state, access FROM "${table}"`)
  for (const row of rows) {
    const id = row.id as string
    const access = JSON.parse(row.access as string) as AccessRules
    await inner.create(id, {}, access)
    await inner.apply({ id, update: row.state as string, origin: 'restore' }) // history-preserving applyUpdate
  }

  // Persistence subscriber: off the hot path, debounced per-id. Also the point where a data write (apply /
  // co-write) bumps updated_at, since snapshot() stamps it.
  inner.onChange((change) => {
    cancel(change.id)
    timers.set(
      change.id,
      setTimeout(() => {
        timers.delete(change.id)
        void snapshot(change.id)
      }, debounceMs),
    )
  })

  return {
    ...inner,
    async create(id, data, accessRules) {
      await inner.create(id, data, accessRules)
      const res = await inner.read(id) // create does not fire onChange — persist the initial state eagerly
      const ts = now()
      await client.batch([
        {
          sql: `INSERT INTO "${table}" (id, state, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          args: [id, (res?.data ?? '') as string, JSON.stringify(accessRules), ts, ts],
        },
        { sql: `INSERT OR IGNORE INTO "${aclTable}" (resource_id, principal) SELECT ?, key FROM json_each(?)`, args: [id, JSON.stringify(accessRules)] },
      ])
    },
    async setAccess(id, accessRules) {
      await inner.setAccess(id, accessRules)
      await client.batch([
        { sql: `DELETE FROM "${aclTable}" WHERE resource_id = ?`, args: [id] },
        { sql: `INSERT OR IGNORE INTO "${aclTable}" (resource_id, principal) SELECT ?, key FROM json_each(?)`, args: [id, JSON.stringify(accessRules)] },
        { sql: `UPDATE "${table}" SET access = ?, updated_at = ? WHERE id = ?`, args: [JSON.stringify(accessRules), now(), id] },
      ])
    },
    async delete(id) {
      cancel(id) // drop any pending flush so it can't resurrect the row
      await inner.delete(id)
      await client.batch([
        { sql: `DELETE FROM "${table}" WHERE id = ?`, args: [id] },
        { sql: `DELETE FROM "${aclTable}" WHERE resource_id = ?`, args: [id] },
      ])
    },
    async list(opts) {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      const where: string[] = []
      const args: (string | number)[] = []
      if (idContains) {
        where.push(`instr(r.id, ?) > 0`) // case-sensitive substring (SQLite LIKE is case-insensitive for ASCII)
        args.push(idContains)
      }
      if (principals?.length) {
        const ph = principals.map(() => '?').join(', ')
        where.push(`r.id IN (SELECT resource_id FROM "${aclTable}" WHERE principal IN (${ph}))`) // OR / union
        args.push(...principals)
      }
      const cols: Record<string, string> = { id: 'id', createdAt: 'createdAt', updatedAt: 'updatedAt', principalCount: 'principalCount' }
      const by = cols[sort?.by ?? 'id'] ?? 'id'
      const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC'
      const orderBy = by === 'id' ? `id ${dir}` : `${by} ${dir}, id ASC` // id tiebreak keeps ties deterministic
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const limitSql = limit === undefined ? 'LIMIT -1' : 'LIMIT ?' // -1 = unbounded (needed to keep OFFSET)
      if (limit !== undefined) args.push(limit)
      args.push(offset)
      const sql = `SELECT r.id AS id, (SELECT COUNT(*) FROM "${aclTable}" a WHERE a.resource_id = r.id) AS principalCount, r.created_at AS createdAt, r.updated_at AS updatedAt FROM "${table}" r ${whereSql} ORDER BY ${orderBy} ${limitSql} OFFSET ?`
      const { rows: out } = await client.execute({ sql, args })
      return out.map((r): ResourceSummary => ({ id: r.id as string, principalCount: Number(r.principalCount), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) }))
    },
    async searchPrincipals(opts) {
      const { query, limit, offset = 0 } = opts
      const args: (string | number)[] = []
      let whereSql = ''
      if (query) {
        whereSql = `WHERE instr(principal, ?) > 0` // case-sensitive substring
        args.push(query)
      }
      const limitSql = limit === undefined ? 'LIMIT -1' : 'LIMIT ?'
      if (limit !== undefined) args.push(limit)
      args.push(offset)
      const sql = `SELECT DISTINCT principal FROM "${aclTable}" ${whereSql} ORDER BY principal ASC ${limitSql} OFFSET ?`
      const { rows: out } = await client.execute({ sql, args })
      return out.map((r) => r.principal as string)
    },
    async close() {
      const ids = [...timers.keys()]
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const id of ids) await snapshot(id) // flush pending edits on a clean shutdown
      client.close()
    },
  }
}
