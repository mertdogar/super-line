import { getLogger } from '@logtape/logtape'

const log = getLogger(['super-line', 'collections-cloudflare', 'synced-sql'])

/** A cell on the wire: SQLite's own types, with a blob as base64 under `blob`. */
export type Value = string | number | null | { blob: string }
export type Statement = { sql: string; params?: Value[] }
export type Result = {
  columns: string[]
  rows: Value[][]
  meta: { rowsRead: number; rowsWritten: number }
}
/** `bytes` is set when the batch's rows passed `maxBytes`; the message then names the cap. */
export type Outcome = { results: Result[] } | { error: string; statement: number; bytes?: number }
/**
 * `readOnly` rolls the batch back as soon as a statement writes a row or changes the schema; `maxBytes` rolls it
 * back as soon as the serialized rows of the batch pass the cap.
 */
export type QueryOptions = { readOnly?: boolean; maxBytes?: number }

/** One row of a user table: `id` is its single-column primary key, else its rowid, as a string. */
export type RemoteRow = { table: string; id: string; data: Record<string, Value> }
export type RemoteChange =
  | { table: string; id: string; op: 'put'; data: Record<string, Value> }
  | { table: string; id: string; op: 'delete' }
/**
 * `wipeAll`: the history since that clock is gone (pruned, a dropped, renamed or altered table, a clock from the
 * future) or is longer than `maxPullChanges`; `changes` is then empty.
 */
export type RemoteChanges = { epoch: string; clock: number; changes: RemoteChange[]; wipeAll: boolean }
/** `changes` is `undefined` when the batch was too large to inline or broke the history: pull `changesSince`. */
export type RemotePush = { epoch: string; clock: number; changes: RemoteChange[] | undefined }

export interface SyncedSqlOptions {
  /** Delete markers kept for `changesSince`; older ones are pruned and the history starts later. Default 1000. */
  maxTombstones?: number
  /** Changes a push carries inline; a larger batch pushes the clock only. Default 500. */
  maxInlineChanges?: number
  /** Changes `changesSince` answers with; a longer backlog answers `wipeAll` instead. Default 5000. */
  maxPullChanges?: number
  /** Called after every batch that changed rows, once it committed. A throw or rejection is logged and dropped. */
  onChange?: (push: RemotePush) => unknown
}

export interface SyncedSql {
  query(statements: Statement[], opts?: QueryOptions): Outcome
  snapshot(table: string, limit: number): RemoteRow[]
  get(table: string, id: string): RemoteRow | undefined
  changesSince(clock: number): RemoteChanges
}

export const READ_ONLY_MESSAGE = 'Read-only: the statement wrote rows or changed the schema and was rolled back'

/** Half the 32 MiB Durable Object RPC limit. */
const MAX_BYTES = 16 * 1024 * 1024

const INSTALL = [
  'CREATE TABLE IF NOT EXISTS _sl_meta (epoch TEXT NOT NULL, clock INTEGER NOT NULL, historyStartsAt INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS _sl_changes (tbl TEXT NOT NULL, id, clock INTEGER NOT NULL, op TEXT NOT NULL, PRIMARY KEY (tbl, id))',
  'CREATE INDEX IF NOT EXISTS _sl_changes_clock ON _sl_changes (op, clock)',
]
// Our triggers count, so a table dropped and recreated identically in one batch still changes it.
const SIGNATURE_SQL = `SELECT group_concat(type || ' ' || name || ' ' || ifnull(sql, ''), char(10)) AS s FROM sqlite_master
  WHERE tbl_name NOT GLOB '_sl_*'`
const TRIGGERS_SQL = `SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' AND name GLOB '_sl_*'`
const TRACKED_SQL = `SELECT r.name AS name, r.tbl_name AS tbl, t.sql AS sql FROM sqlite_master AS r
  JOIN sqlite_master AS t ON t.type = 'table' AND t.name = r.tbl_name WHERE r.type = 'trigger' AND r.name GLOB '_sl_i_*'`
const TABLES_SQL = `SELECT l.name AS name, l.wr AS wr,
  (SELECT count(*) FROM pragma_table_info(l.name) WHERE pk > 0) AS pks,
  (SELECT name FROM pragma_table_info(l.name) WHERE pk = 1) AS pk
  FROM pragma_table_list() AS l
  WHERE l.schema = 'main' AND l.type = 'table' AND l.name NOT GLOB 'sqlite_*' AND l.name NOT GLOB '_cf_*' AND l.name NOT GLOB '_sl_*'`

type Trigger = { name: string; tbl: string }
const OPS = ['i', 'u', 'd'] as const
const triggerName = (op: (typeof OPS)[number], table: string) => `_sl_${op}_${table}`
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

const toBase64 = (buffer: ArrayBuffer): string => {
  let s = ''
  for (const byte of new Uint8Array(buffer)) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromBase64 = (text: string): ArrayBuffer => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer
const decode = (value: Value) => (value !== null && typeof value === 'object' ? fromBase64(value.blob) : value)
const encode = (value: SqlStorageValue): Value => (value instanceof ArrayBuffer ? { blob: toBase64(value) } : value)
const idOf = (value: SqlStorageValue): string => (value instanceof ArrayBuffer ? toBase64(value) : String(value))

const utf8 = new TextEncoder()

class ResultTooLarge extends Error {
  constructor(public bytes: number) {
    super('The result is over the cap')
  }
}

// Logs one row change at the batch's pending clock. Delete-then-insert, not INSERT OR REPLACE: an outer
// `INSERT OR IGNORE` would impose its own conflict policy on the trigger's insert and skip it.
const record = (tbl: string, id: string, op: 'put' | 'delete', when = '') =>
  `DELETE FROM _sl_changes WHERE tbl = ${tbl} AND id = ${id};` +
  ` INSERT INTO _sl_changes (tbl, id, clock, op) SELECT ${tbl}, ${id}, clock + 1, '${op}' FROM _sl_meta${when};`

const triggers = (table: string, key: string): string[] => {
  const tbl = literal(table)
  const on = ident(table)
  const [i, u, d] = OPS.map((op) => ident(triggerName(op, table)))
  return [
    `CREATE TRIGGER IF NOT EXISTS ${i} AFTER INSERT ON ${on} BEGIN ${record(tbl, `NEW.${key}`, 'put')} END`,
    `CREATE TRIGGER IF NOT EXISTS ${u} AFTER UPDATE ON ${on} BEGIN ` +
      `${record(tbl, `OLD.${key}`, 'delete', ` WHERE OLD.${key} IS NOT NEW.${key}`)} ${record(tbl, `NEW.${key}`, 'put')} END`,
    `CREATE TRIGGER IF NOT EXISTS ${d} AFTER DELETE ON ${on} BEGIN ${record(tbl, `OLD.${key}`, 'delete')} END`,
  ]
}

/**
 * Change capture over a Durable Object's own SQLite, for an object whose tables are created at runtime by arbitrary
 * SQL. `query` is the object's one write funnel: a batch runs in order inside one `transactionSync`, and the first
 * failure rolls the whole batch back and reports SQLite's message.
 *
 * Every user table gets `AFTER INSERT/UPDATE/DELETE` triggers that log into `_sl_changes` at a clock that bumps once
 * per write batch; a batch that changes the schema re-syncs them, and a table it created is logged whole. A row's id
 * is its single-column primary key, else its rowid; a `WITHOUT ROWID` table with a composite key is skipped, with a
 * warning. Dropping, renaming or altering the columns of a table breaks the history, so `changesSince` from before
 * it says `wipeAll`, as it does past `maxTombstones` pruned deletes and for a backlog over `maxPullChanges`. The `_sl_` prefix is reserved, and the connection runs with
 * `recursive_triggers` on, so a `REPLACE` that evicts a conflicting row logs its delete.
 *
 * ```ts
 * private sync = syncedSql(this.ctx, { onChange: (push) => this.env.NODE.getByName('node').changed(push) })
 * query(statements: Statement[], opts?: QueryOptions) { return this.sync.query(statements, opts) }
 * ```
 */
export function syncedSql(ctx: DurableObjectState, opts: SyncedSqlOptions = {}): SyncedSql {
  const { maxTombstones = 1000, maxInlineChanges = 500, maxPullChanges = 5000, onChange } = opts
  const storage = ctx.storage
  const sql = storage.sql
  const rows = <T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]) => sql.exec<T>(query, ...params).toArray()
  const count = (query: string, ...params: unknown[]) => sql.exec<{ n: number }>(query, ...params).one().n
  const meta = () => sql.exec<{ epoch: string; clock: number; historyStartsAt: number }>('SELECT * FROM _sl_meta').one()
  const signature = () => sql.exec<{ s: string | null }>(SIGNATURE_SQL).one().s

  // A table's id expression, or undefined for one whose rows have no single id.
  const userTables = (): Map<string, string | undefined> => {
    const tables = new Map<string, string | undefined>()
    for (const t of rows<{ name: string; wr: number; pks: number; pk: string | null }>(TABLES_SQL)) {
      tables.set(t.name, t.pks === 1 && t.pk !== null ? ident(t.pk) : t.wr === 0 ? 'rowid' : undefined)
    }
    return tables
  }

  // The tables with triggers, each with its CREATE statement, which every column change rewrites.
  const tracked = (): Map<string, string> => {
    const tables = new Map<string, string>()
    for (const { name, tbl, sql: create } of rows<Trigger & { sql: string }>(TRACKED_SQL))
      if (name === triggerName('i', tbl)) tables.set(tbl, create)
    return tables
  }

  // Installs triggers on tables that lack them. A tracked table that lost its triggers (dropped or renamed) or
  // changed its columns breaks the history, and its log goes. Otherwise a table new since `before` is logged whole
  // at `backfillAt`.
  const sync = (before: Map<string, string>, backfillAt?: number): boolean => {
    for (const { name, tbl } of rows<Trigger>(TRIGGERS_SQL)) {
      if (/^_sl_[iud]_/.test(name) && !OPS.some((op) => triggerName(op, tbl) === name)) sql.exec(`DROP TRIGGER ${ident(name)}`)
    }
    const now = tracked()
    const lost = [...before].filter(([t, create]) => now.get(t) !== create).map(([t]) => t)
    for (const t of lost) sql.exec('DELETE FROM _sl_changes WHERE tbl = ?', t)
    for (const [table, key] of userTables()) {
      if (now.has(table)) continue
      if (key === undefined) {
        log.warning('Table {table} has a composite primary key and no rowid; its changes are not synced', { table })
        continue
      }
      for (const trigger of triggers(table, key)) sql.exec(trigger)
      if (backfillAt !== undefined && lost.length === 0)
        sql.exec(`INSERT INTO _sl_changes (tbl, id, clock, op) SELECT ?, ${key}, ?, 'put' FROM ${ident(table)}`, table, backfillAt)
    }
    return lost.length > 0
  }

  const ensure = () => {
    sql.exec('PRAGMA recursive_triggers = ON')
    if (rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sl_meta'`).length > 0) return
    storage.transactionSync(() => {
      for (const ddl of INSTALL) sql.exec(ddl)
      sql.exec('INSERT INTO _sl_meta (epoch, clock, historyStartsAt) VALUES (?, 0, 0)', crypto.randomUUID())
      sync(new Map())
    })
  }

  const read = (table: string, query: string, ...params: unknown[]): RemoteRow[] => {
    const cursor = sql.exec(query, ...params)
    const columns = cursor.columnNames.slice(1)
    return Array.from(cursor.raw(), ([id, ...values]) => ({
      table,
      id: idOf(id as SqlStorageValue),
      data: Object.fromEntries(columns.map((c, i) => [c, encode(values[i] as SqlStorageValue)])),
    }))
  }

  const changes = (since: number): RemoteChange[] => {
    const out: RemoteChange[] = []
    for (const { tbl, id } of rows<{ tbl: string; id: SqlStorageValue }>(`SELECT tbl, id FROM _sl_changes WHERE op = 'delete' AND clock > ?`, since))
      out.push({ table: tbl, id: idOf(id), op: 'delete' })
    const tables = userTables()
    for (const { tbl: table } of rows<{ tbl: string }>(`SELECT DISTINCT tbl FROM _sl_changes WHERE op = 'put' AND clock > ?`, since)) {
      const key = tables.get(table)
      if (key === undefined) continue
      const query = `SELECT t.${key}, t.* FROM ${ident(table)} AS t JOIN _sl_changes AS c ON c.id = t.${key}
        WHERE c.tbl = ? AND c.op = 'put' AND c.clock > ?`
      for (const row of read(table, query, table, since)) out.push({ ...row, op: 'put' })
    }
    return out
  }

  // Drops the oldest delete markers past the cap, never splitting a clock, and starts the history after them.
  const prune = () => {
    const over = count(`SELECT count(*) AS n FROM _sl_changes WHERE op = 'delete'`) - maxTombstones
    if (over <= 0) return
    const cutoff = count(`SELECT clock AS n FROM _sl_changes WHERE op = 'delete' ORDER BY clock LIMIT 1 OFFSET ?`, over - 1)
    sql.exec(`DELETE FROM _sl_changes WHERE op = 'delete' AND clock <= ?`, cutoff)
    sql.exec('UPDATE _sl_meta SET historyStartsAt = max(historyStartsAt, ?)', cutoff)
  }

  // Runs inside the batch's transaction, after its statements.
  const commit = (before: { signature: string | null; tracked: Map<string, string> }): RemotePush | undefined => {
    const { epoch, clock } = meta()
    const next = clock + 1
    const broken = signature() !== before.signature && sync(before.tracked, next)
    const logged = count(`SELECT count(*) AS n FROM _sl_changes WHERE op IN ('put', 'delete') AND clock = ?`, next)
    if (logged === 0 && !broken) return undefined
    sql.exec('UPDATE _sl_meta SET clock = ?', next)
    if (broken) sql.exec('UPDATE _sl_meta SET historyStartsAt = ?', next)
    prune()
    if (!onChange) return undefined
    const inline = meta().historyStartsAt < next && logged <= maxInlineChanges
    return { epoch, clock: next, changes: inline ? changes(clock) : undefined }
  }

  const notify = (push: RemotePush) =>
    ctx.waitUntil(
      Promise.resolve()
        .then(() => onChange?.(push))
        .catch((error: unknown) => log.error('onChange failed for clock {clock}: {error}', { clock: push.clock, error })),
    )

  // Stops pulling the cursor at the row that takes the batch past its byte cap.
  const run = ({ sql: query, params = [] }: Statement, budget: { bytes: number; maxBytes: number }): Result => {
    const cursor = sql.exec(query, ...params.map(decode))
    const out: Value[][] = []
    for (const raw of cursor.raw()) {
      const row = raw.map(encode)
      budget.bytes += utf8.encode(JSON.stringify(row)).byteLength + 1
      if (budget.bytes > budget.maxBytes) throw new ResultTooLarge(budget.bytes)
      out.push(row)
    }
    return { columns: cursor.columnNames, rows: out, meta: { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten } }
  }

  return {
    query(statements, { readOnly = false, maxBytes = MAX_BYTES } = {}) {
      let index = 0
      const budget = { bytes: 0, maxBytes }
      try {
        ensure()
        const { results, push } = storage.transactionSync(() => {
          const before = readOnly ? undefined : { signature: signature(), tracked: tracked() }
          const results = statements.map((statement, i) => {
            index = i
            if (!readOnly) return run(statement, budget)
            // a drop writes no rows, so the schema is compared too
            const schema = signature()
            const result = run(statement, budget)
            if (result.meta.rowsWritten > 0 || signature() !== schema) throw new Error(READ_ONLY_MESSAGE)
            return result
          })
          return { results, push: before && commit(before) }
        })
        if (push) notify(push)
        return { results }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ResultTooLarge) return { error: message, statement: index, bytes: error.bytes }
        return { error: message, statement: index }
      }
    },
    snapshot(table, limit) {
      ensure()
      const key = userTables().get(table)
      if (key === undefined) return []
      return read(table, `SELECT ${key}, * FROM ${ident(table)} LIMIT ?`, limit)
    },
    get(table, id) {
      ensure()
      const key = userTables().get(table)
      if (key === undefined) return undefined
      return read(table, `SELECT ${key}, * FROM ${ident(table)} WHERE ${key} = ?`, id).find((row) => row.id === id)
    },
    changesSince(since) {
      ensure()
      const { epoch, clock, historyStartsAt } = meta()
      const wipeAll =
        since < historyStartsAt ||
        since > clock ||
        count(`SELECT count(*) AS n FROM _sl_changes WHERE op IN ('put', 'delete') AND clock > ?`, since) > maxPullChanges
      return { epoch, clock, changes: wipeAll ? [] : changes(since), wipeAll }
    },
  }
}
