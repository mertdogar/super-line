import { createClient } from '@libsql/client'
import { syncStoreServer } from '@super-line/store-sync'
import type { DocOptions } from '@super-line/store-sync'
import type { AccessRules, ServerStore } from '@super-line/core'

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
 */
export async function libsqlSyncStore(opts: LibsqlSyncStoreOptions): Promise<ServerStore> {
  const table = opts.table ?? 'resources'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`)
  const debounceMs = opts.debounceMs ?? 250

  const client = createClient({ url: opts.url, authToken: opts.authToken })
  await client.execute(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, state TEXT NOT NULL, access TEXT NOT NULL)`)

  const inner = syncStoreServer({ resolveOptions: opts.resolveOptions })
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const snapshot = async (id: string): Promise<void> => {
    const res = await inner.read(id)
    if (!res) return
    await client.execute({
      sql: `INSERT INTO "${table}" (id, state, access) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
      args: [id, res.data as string, JSON.stringify(res.accessRules)],
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

  // Persistence subscriber: off the hot path, debounced per-id.
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
      await client.execute({
        sql: `INSERT INTO "${table}" (id, state, access) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        args: [id, (res?.data ?? '') as string, JSON.stringify(accessRules)],
      })
    },
    async setAccess(id, accessRules) {
      await inner.setAccess(id, accessRules)
      await client.execute({ sql: `UPDATE "${table}" SET access = ? WHERE id = ?`, args: [JSON.stringify(accessRules), id] })
    },
    async delete(id) {
      cancel(id) // drop any pending flush so it can't resurrect the row
      await inner.delete(id)
      await client.execute({ sql: `DELETE FROM "${table}" WHERE id = ?`, args: [id] })
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
