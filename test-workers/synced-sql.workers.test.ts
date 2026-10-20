import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { READ_ONLY_MESSAGE, syncedSql } from '@super-line/collections-cloudflare'
import type { RemoteChange, RemotePush, Statement } from '@super-line/collections-cloudflare'
import { waitFor } from '../packages/core/test/wait.js'

// syncedSql in a real Durable Object (`SqlSourceNode`: maxTombstones 4, maxInlineChanges 3, maxPullChanges 5), driven over RPC the
// way a node would. Each test takes a fresh object: storage is not reset between files in this lane.

const source = () => env.SQL_SOURCE.get(env.SQL_SOURCE.idFromName(`source-${crypto.randomUUID()}`))
type Source = ReturnType<typeof source>

const exec = async (src: Source, ...statements: (string | Statement)[]) => {
  const outcome = await src.query(statements.map((s) => (typeof s === 'string' ? { sql: s } : s)))
  if ('error' in outcome) throw new Error(`statement ${outcome.statement}: ${outcome.error}`)
  return outcome.results
}
const sorted = (changes: RemoteChange[]) => [...changes].sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`))
const clockOf = async (src: Source) => (await src.changesSince(0)).clock

describe('syncedSql change capture', () => {
  it('logs inserts, updates and deletes at one clock per write batch, one entry per row', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE dishes (id TEXT PRIMARY KEY, name TEXT, price REAL)')
    expect(await src.changesSince(0)).toMatchObject({ clock: 0, changes: [], wipeAll: false })

    await exec(src, "INSERT INTO dishes VALUES ('a', 'soup', 4.5)", "INSERT INTO dishes VALUES ('b', 'bread', 2)")
    const first = await src.changesSince(0)
    expect(first.clock).toBe(1)
    expect(sorted(first.changes)).toEqual([
      { table: 'dishes', id: 'a', op: 'put', data: { id: 'a', name: 'soup', price: 4.5 } },
      { table: 'dishes', id: 'b', op: 'put', data: { id: 'b', name: 'bread', price: 2 } },
    ])

    await exec(src, "UPDATE dishes SET price = 5 WHERE id = 'a'")
    expect((await src.changesSince(1)).changes).toEqual([{ table: 'dishes', id: 'a', op: 'put', data: { id: 'a', name: 'soup', price: 5 } }])

    await exec(src, "DELETE FROM dishes WHERE id = 'b'")
    expect(await src.changesSince(2)).toMatchObject({ clock: 3, wipeAll: false, changes: [{ table: 'dishes', id: 'b', op: 'delete' }] })
    expect(sorted((await src.changesSince(0)).changes)).toEqual([
      { table: 'dishes', id: 'a', op: 'put', data: { id: 'a', name: 'soup', price: 5 } },
      { table: 'dishes', id: 'b', op: 'delete' },
    ])

    await exec(src, 'SELECT * FROM dishes', "UPDATE dishes SET price = 1 WHERE id = 'nope'")
    expect(await clockOf(src)).toBe(3)
  })

  it('ids a table without a single-column key by rowid, and skips a composite key without one', async () => {
    const src = source()
    await exec(
      src,
      'CREATE TABLE notes (body TEXT)',
      'CREATE TABLE pairs (a INTEGER, b INTEGER, n TEXT, PRIMARY KEY (a, b))',
      'CREATE TABLE edges (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID',
    )
    await exec(src, "INSERT INTO notes VALUES ('hi')", "INSERT INTO pairs VALUES (1, 2, 'x')", "INSERT INTO edges VALUES ('p', 'q')")
    expect(sorted((await src.changesSince(0)).changes)).toEqual([
      { table: 'notes', id: '1', op: 'put', data: { body: 'hi' } },
      { table: 'pairs', id: '1', op: 'put', data: { a: 1, b: 2, n: 'x' } },
    ])
    expect(await src.snapshot('edges', 10)).toEqual([])
  })

  it('an UPDATE that changes the key logs a delete of the old id and a put of the new', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE dishes (id TEXT PRIMARY KEY, name TEXT)', "INSERT INTO dishes VALUES ('a', 'soup')")
    const clock = await clockOf(src)
    await exec(src, "UPDATE dishes SET id = 'z' WHERE id = 'a'")
    expect(sorted((await src.changesSince(clock)).changes)).toEqual([
      { table: 'dishes', id: 'a', op: 'delete' },
      { table: 'dishes', id: 'z', op: 'put', data: { id: 'z', name: 'soup' } },
    ])
  })

  it('captures a table created after install, and the rows of one created in the same batch', async () => {
    const src = source()
    await exec(src, 'SELECT 1')
    await exec(src, 'CREATE TABLE later (id INTEGER PRIMARY KEY, v TEXT)')
    await exec(src, "INSERT INTO later (v) VALUES ('one')")
    expect((await src.changesSince(0)).changes).toEqual([{ table: 'later', id: '1', op: 'put', data: { id: 1, v: 'one' } }])

    const clock = await clockOf(src)
    const odd = `"it's ""odd"""`
    await exec(src, `CREATE TABLE ${odd} (id TEXT PRIMARY KEY)`, `INSERT INTO ${odd} VALUES ('x'), ('y')`, `DELETE FROM ${odd} WHERE id = 'y'`)
    expect(await src.changesSince(clock)).toMatchObject({
      clock: clock + 1,
      wipeAll: false,
      changes: [{ table: `it's "odd"`, id: 'x', op: 'put', data: { id: 'x' } }],
    })
    await exec(src, `INSERT INTO ${odd} VALUES ('w')`)
    expect((await src.changesSince(clock + 1)).changes).toEqual([{ table: `it's "odd"`, id: 'w', op: 'put', data: { id: 'w' } }])
  })

  it('a REPLACE that evicts a conflicting row logs its delete, and an OR IGNORE re-insert logs a put', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE)', "INSERT INTO users VALUES ('a', 'x@y')")
    const replaced = await clockOf(src)
    await exec(src, "INSERT OR REPLACE INTO users VALUES ('b', 'x@y')")
    expect(sorted((await src.changesSince(replaced)).changes)).toEqual([
      { table: 'users', id: 'a', op: 'delete' },
      { table: 'users', id: 'b', op: 'put', data: { id: 'b', email: 'x@y' } },
    ])

    await exec(src, "DELETE FROM users WHERE id = 'b'")
    const deleted = await clockOf(src)
    await exec(src, "INSERT OR IGNORE INTO users VALUES ('b', 'z@y')")
    expect((await src.changesSince(deleted)).changes).toEqual([{ table: 'users', id: 'b', op: 'put', data: { id: 'b', email: 'z@y' } }])
  })

  it('a dropped, renamed or recreated table breaks the history; changes after it are captured again', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE a (id TEXT PRIMARY KEY)', "INSERT INTO a VALUES ('1')", 'CREATE TABLE b (id TEXT PRIMARY KEY)', "INSERT INTO b VALUES ('1')")
    const clock = await clockOf(src)

    await exec(src, 'DROP TABLE a')
    expect(await src.changesSince(clock)).toMatchObject({ clock: clock + 1, changes: [], wipeAll: true })
    expect(await src.changesSince(clock + 1)).toMatchObject({ changes: [], wipeAll: false })

    await exec(src, 'ALTER TABLE b RENAME TO c')
    expect(await src.changesSince(clock + 1)).toMatchObject({ clock: clock + 2, wipeAll: true })
    await exec(src, "INSERT INTO c VALUES ('2')")
    expect((await src.changesSince(clock + 2)).changes).toEqual([{ table: 'c', id: '2', op: 'put', data: { id: '2' } }])
    expect(await src.snapshot('b', 10)).toEqual([])

    await exec(src, 'DROP TABLE c', 'CREATE TABLE c (id TEXT PRIMARY KEY)', "INSERT INTO c VALUES ('3')")
    expect(await src.changesSince(clock + 3)).toMatchObject({ clock: clock + 4, wipeAll: true })
    await exec(src, "INSERT INTO c VALUES ('4')")
    expect((await src.changesSince(clock + 4)).changes).toEqual([{ table: 'c', id: '4', op: 'put', data: { id: '4' } }])

    await exec(src, 'DROP TABLE c', 'CREATE TABLE c (id TEXT PRIMARY KEY)', "INSERT INTO c VALUES ('5')") // the same CREATE again
    expect(await src.changesSince(clock + 5)).toMatchObject({ clock: clock + 6, wipeAll: true })
    await exec(src, "INSERT INTO c VALUES ('6')")
    expect((await src.changesSince(clock + 6)).changes).toEqual([{ table: 'c', id: '6', op: 'put', data: { id: '6' } }])
  })

  it('a column change breaks the history like a dropped table, and pushes the clock alone', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)', "INSERT INTO t VALUES ('a', 'x')")
    const alters = [
      'ALTER TABLE t ADD COLUMN extra TEXT',
      'ALTER TABLE t RENAME COLUMN extra TO more',
      'ALTER TABLE t DROP COLUMN more',
      'ALTER TABLE t RENAME COLUMN id TO key',
    ]
    for (const alter of alters) {
      const clock = await clockOf(src)
      await exec(src, alter)
      expect(await src.changesSince(clock)).toMatchObject({ clock: clock + 1, changes: [], wipeAll: true })
    }
    await exec(src, "INSERT INTO t VALUES ('b', 'y')")
    expect((await src.changesSince(5)).changes).toEqual([{ table: 't', id: 'b', op: 'put', data: { key: 'b', v: 'y' } }])

    const pushes: RemotePush[] = []
    await waitFor(async () => pushes.push(...(await src.takePushes())) >= 6, { label: 'six pushes' })
    expect(pushes.map((p) => [p.clock, p.changes?.length])).toEqual([
      [1, 1],
      [2, undefined],
      [3, undefined],
      [4, undefined],
      [5, undefined],
      [6, 1],
    ])
  })

  it('a read-only batch rolls back at the first write or schema change, and lets reads through', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)', "INSERT INTO t VALUES ('a')")
    const readOnly = (sql: string) => src.query([{ sql: 'SELECT 1' }, { sql }], { readOnly: true })
    for (const sql of ["INSERT INTO t VALUES ('b')", 'CREATE TABLE u (id TEXT)', 'CREATE INDEX t_id ON t (id)', 'DROP TABLE t']) {
      expect(await readOnly(sql)).toEqual({ error: READ_ONLY_MESSAGE, statement: 1 })
    }
    expect(await src.query([{ sql: 'SELECT id FROM t' }], { readOnly: true })).toMatchObject({
      results: [{ columns: ['id'], rows: [['a']], meta: { rowsWritten: 0 } }],
    })
    expect(await src.snapshot('t', 10)).toEqual([{ table: 't', id: 'a', data: { id: 'a' } }])
    expect(await src.changesSince(1)).toMatchObject({ clock: 1, changes: [], wipeAll: false })
  })

  it('a read-only batch catches a write in any statement of a multi-statement string, and leaves no log entry', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)', "INSERT INTO t VALUES ('a')")
    // the cursor's rowsWritten counts only the last statement of the string, here the SELECT
    expect(await src.query([{ sql: "INSERT INTO t VALUES ('b'); SELECT 1" }], { readOnly: true })).toEqual({
      error: READ_ONLY_MESSAGE,
      statement: 0,
    })
    expect(await src.snapshot('t', 10)).toEqual([{ table: 't', id: 'a', data: { id: 'a' } }])
    expect(await exec(src, "SELECT count(*) FROM _sl_changes WHERE id = 'b'")).toMatchObject([{ rows: [[0]] }])
    await exec(src, "INSERT INTO t VALUES ('c')")
    expect(await src.changesSince(1)).toMatchObject({ clock: 2, changes: [{ table: 't', id: 'c', op: 'put' }] })
  })

  it("never tracks miniflare's own table, which its dev wrapper rewrites on every wake", async () => {
    const src = source()
    await exec(src, 'CREATE TABLE __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)', "INSERT OR REPLACE INTO __miniflare_do_name VALUES (1, 'n')")
    await exec(src, "INSERT OR REPLACE INTO __miniflare_do_name VALUES (1, 'n')")
    expect(await src.changesSince(0)).toMatchObject({ clock: 0, changes: [], wipeAll: false })
    expect(await exec(src, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '__miniflare_do_name'")).toMatchObject([{ rows: [] }])
  })

  it('a failed statement rolls the whole batch back without moving the clock; maxBytes caps the rows', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)')
    expect(await src.query([{ sql: "INSERT INTO t VALUES ('a')" }, { sql: 'INSERT INTO nope VALUES (1)' }])).toMatchObject({
      statement: 1,
      error: expect.stringMatching(/no such table/),
    })
    expect(await src.changesSince(0)).toMatchObject({ clock: 0, changes: [] })
    expect(await src.snapshot('t', 10)).toEqual([])
    expect(await src.query([{ sql: 'SELECT 1' }, { sql: "SELECT 'a long enough value'" }], { maxBytes: 10 })).toMatchObject({
      statement: 1,
      bytes: expect.any(Number),
    })
  })

  it('prunes the oldest delete markers past maxTombstones without splitting a clock', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'INSERT INTO t VALUES (1), (2), (3), (4), (5), (6)')
    await exec(src, 'DELETE FROM t WHERE id IN (1, 2)')
    await exec(src, 'DELETE FROM t WHERE id IN (3, 4)')
    const full = await src.changesSince(1)
    expect(full).toMatchObject({ clock: 3, wipeAll: false })
    expect(full.changes).toHaveLength(4)

    await exec(src, 'DELETE FROM t WHERE id = 5') // a fifth marker: clock 2's pair goes, both of it
    expect(await src.changesSince(1)).toMatchObject({ clock: 4, changes: [], wipeAll: true })
    expect(sorted((await src.changesSince(2)).changes)).toEqual([
      { table: 't', id: '3', op: 'delete' },
      { table: 't', id: '4', op: 'delete' },
      { table: 't', id: '5', op: 'delete' },
    ])
  })

  it('a backlog over maxPullChanges says wipeAll rather than a partial list', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'INSERT INTO t VALUES (1), (2), (3), (4), (5), (6)')
    await exec(src, 'DELETE FROM t WHERE id = 1')
    expect(await src.changesSince(0)).toMatchObject({ clock: 2, changes: [], wipeAll: true })
    expect(await src.changesSince(1)).toMatchObject({ clock: 2, changes: [{ table: 't', id: '1', op: 'delete' }], wipeAll: false })
  })

  it('a clock from the future says wipeAll', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)', "INSERT INTO t VALUES ('a')")
    expect(await src.changesSince(99)).toMatchObject({ clock: 1, changes: [], wipeAll: true })
  })

  it('deleteAll and reuse restart the clock under a new epoch', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)', "INSERT INTO t VALUES ('a')")
    await exec(src, "INSERT INTO t VALUES ('b')")
    const before = await src.changesSince(0)
    expect(before.clock).toBe(2)

    await src.destroy()
    await exec(src, 'CREATE TABLE t (id TEXT PRIMARY KEY)', "INSERT INTO t VALUES ('c')")
    const after = await src.changesSince(0)
    expect(after.epoch).not.toBe(before.epoch)
    expect(after).toMatchObject({ clock: 1, wipeAll: false, changes: [{ table: 't', id: 'c', op: 'put' }] })
    expect((await src.changesSince(before.clock)).wipeAll).toBe(true)
  })

  it('blobs round-trip as base64 through params, results, snapshot and changes', async () => {
    const src = source()
    const blob = { blob: btoa(String.fromCharCode(0, 1, 127, 128, 254, 255)) }
    await exec(src, 'CREATE TABLE files (id TEXT PRIMARY KEY, body BLOB)', { sql: 'INSERT INTO files VALUES (?, ?)', params: ['f', blob] })
    expect(await exec(src, 'SELECT body, typeof(body) AS t FROM files')).toMatchObject([{ rows: [[blob, 'blob']] }])
    expect(await src.snapshot('files', 10)).toEqual([{ table: 'files', id: 'f', data: { id: 'f', body: blob } }])
    expect((await src.changesSince(0)).changes).toEqual([{ table: 'files', id: 'f', op: 'put', data: { id: 'f', body: blob } }])
  })

  it('snapshot reads one user table up to the limit, and never the bookkeeping', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', "INSERT INTO t (v) VALUES ('a'), ('b'), ('c')")
    expect(await src.snapshot('t', 2)).toEqual([
      { table: 't', id: '1', data: { id: 1, v: 'a' } },
      { table: 't', id: '2', data: { id: 2, v: 'b' } },
    ])
    expect(await src.snapshot('_sl_changes', 10)).toEqual([])
    expect(await src.snapshot('missing', 10)).toEqual([])
  })

  it('get reads one row by its id, whatever the type of the key', async () => {
    const src = source()
    await exec(
      src,
      'CREATE TABLE n (id INTEGER PRIMARY KEY, v TEXT)',
      'CREATE TABLE s (id TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE r (v TEXT)',
      "INSERT INTO n VALUES (7, 'seven')",
      "INSERT INTO s VALUES ('7', 'text'), ('a:b', 'colon')",
      "INSERT INTO r VALUES ('first'), ('second')",
    )
    expect(await src.get('n', '7')).toEqual({ table: 'n', id: '7', data: { id: 7, v: 'seven' } })
    expect(await src.get('s', '7')).toEqual({ table: 's', id: '7', data: { id: '7', v: 'text' } })
    expect(await src.get('s', 'a:b')).toEqual({ table: 's', id: 'a:b', data: { id: 'a:b', v: 'colon' } })
    expect(await src.get('r', '2')).toEqual({ table: 'r', id: '2', data: { v: 'second' } })
    expect(await src.get('n', '8')).toBeUndefined()
    expect(await src.get('missing', '1')).toBeUndefined()
  })
})

describe('syncedSql onChange', () => {
  it('pushes each committed batch: inline up to maxInlineChanges, the clock alone above it or past a break', async () => {
    const src = source()
    await exec(src, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    await exec(src, "INSERT INTO t VALUES (1, 'a'), (2, 'b')")
    await exec(src, 'SELECT * FROM t')
    await exec(src, "INSERT INTO t VALUES (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f')")
    await exec(src, 'DROP TABLE t')
    const { epoch } = await src.changesSince(0)

    const pushes: RemotePush[] = []
    await waitFor(async () => pushes.push(...(await src.takePushes())) >= 3, { label: 'three pushes' })
    expect(pushes.map((p) => [p.epoch, p.clock])).toEqual([
      [epoch, 1],
      [epoch, 2],
      [epoch, 3],
    ])
    expect(sorted(pushes[0]!.changes!)).toEqual([
      { table: 't', id: '1', op: 'put', data: { id: 1, v: 'a' } },
      { table: 't', id: '2', op: 'put', data: { id: 2, v: 'b' } },
    ])
    expect(pushes[1]!.changes).toBeUndefined()
    expect(pushes[2]!.changes).toBeUndefined()
  })

  it('a throwing or rejecting onChange is dropped, and the batch still commits', async () => {
    const stub = env.STORE.get(env.STORE.idFromName(`store-${crypto.randomUUID()}`))
    await runInDurableObject(stub, async (_instance, state) => {
      const calls: number[] = []
      const throwing = syncedSql(state, {
        onChange: ({ clock }) => {
          calls.push(clock)
          throw new Error('node down')
        },
      })
      expect(throwing.query([{ sql: 'CREATE TABLE t (id TEXT PRIMARY KEY)' }, { sql: "INSERT INTO t VALUES ('a')" }])).toHaveProperty('results')
      const rejecting = syncedSql(state, {
        onChange: async ({ clock }) => {
          calls.push(clock)
          throw new Error('node down')
        },
      })
      expect(rejecting.query([{ sql: "INSERT INTO t VALUES ('b')" }])).toHaveProperty('results')
      await waitFor(() => calls.length === 2)
      expect(calls).toEqual([1, 2])
      expect(rejecting.changesSince(0).changes).toHaveLength(2)
    })
  })
})
