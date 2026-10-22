import { env, evictDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { createSuperLineClient } from '@super-line/client'
import { and, eq, type RowOf } from '@super-line/core'
import type { Statement } from '@super-line/collections-cloudflare'
import { waitFor } from '../packages/core/test/wait.js'
import { rowsContract, stubTransport } from './app.js'

// remoteRows across two real Durable Objects: SqlSourceNodes named `<node>:<store>` push every committed batch to the
// RowsNode `<node>` (maxInlineChanges 3, so a fourth row in a batch makes the push clock-only), which serves them to a
// client over the Cloudflare transport. Each test takes a fresh node and fresh sources.

type Row = RowOf<typeof rowsContract, 'storeRows'>

const clients: Array<{ close(): void }> = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

function setup() {
  const name = `rows-${crypto.randomUUID()}`
  const node = env.ROWS.getByName(name)
  const lifecycle: string[] = []
  const client = createSuperLineClient(rowsContract, {
    transport: stubTransport(node),
    role: 'user',
    onDisconnect: (code) => lifecycle.push(`disconnect:${code}`),
    onReconnect: () => lifecycle.push('reconnect'),
    reconnectBaseMs: 10,
  })
  clients.push(client)
  const source = (store: string) => env.SQL_SOURCE.getByName(`${name}:${store}`)
  const subscribe = (store = 's1', table = 'dishes') =>
    client.collection('storeRows').subscribe({ filter: and(eq('storeId', store), eq('table', table)) })
  return { node, client, lifecycle, source, subscribe }
}

const exec = async (src: { query(s: Statement[]): Promise<unknown> }, ...sql: string[]) => {
  const outcome = (await src.query(sql.map((s) => ({ sql: s })))) as { error?: string }
  if (outcome.error) throw new Error(outcome.error)
}
const names = (rows: Row[]) => rows.map((r) => `${r.id}=${r.data.name}`).sort().join(' ')
const CREATE = 'CREATE TABLE dishes (id TEXT PRIMARY KEY, name TEXT)'

describe('remoteRows across a source and a node Durable Object', () => {
  it('subscribes into a snapshot, then streams inserts, updates and deletes across the hop', async () => {
    const { source, subscribe } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE, "INSERT INTO dishes VALUES ('a', 'soup')")

    const sub = subscribe()
    const other = subscribe('s2')
    await Promise.all([sub.ready, other.ready])
    expect(sub.rows()).toEqual([{ key: 's1:dishes:a', storeId: 's1', table: 'dishes', id: 'a', data: { id: 'a', name: 'soup' } }])

    await exec(s1, "INSERT INTO dishes VALUES ('b', 'bread')")
    await waitFor(() => names(sub.rows()) === 'a=soup b=bread', { label: 'insert' })
    await exec(s1, "UPDATE dishes SET name = 'stew' WHERE id = 'a'")
    await waitFor(() => names(sub.rows()) === 'a=stew b=bread', { label: 'update' })
    await exec(s1, "DELETE FROM dishes WHERE id = 'b'")
    await waitFor(() => names(sub.rows()) === 'a=stew', { label: 'delete' })
    expect(other.rows()).toEqual([])
  })

  it('a subscription pinned to the store alone spans every table, live', async () => {
    const { client, source } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE, 'CREATE TABLE drinks (id TEXT PRIMARY KEY, name TEXT)', "INSERT INTO dishes VALUES ('a', 'stew')")
    const sub = client.collection('storeRows').subscribe({ filter: eq('storeId', 's1') })
    await sub.ready
    expect(sub.rows().map((r) => r.key)).toEqual(['s1:dishes:a'])

    await exec(s1, "INSERT INTO drinks VALUES ('w', 'water')")
    await waitFor(() => sub.rows().length === 2, { label: 'second table live' })
    expect(sub.rows().map((r) => r.key).sort()).toEqual(['s1:dishes:a', 's1:drinks:w'])
  })

  it('pulls on a clock-only push and on a gap left by a lost push', async () => {
    const { source, subscribe } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE)
    const sub = subscribe()
    await sub.ready

    await exec(s1, "INSERT INTO dishes VALUES ('a', '1'), ('b', '2'), ('c', '3'), ('d', '4')")
    await waitFor(() => sub.rows().length === 4, { label: 'pulled batch' })
    expect((await s1.takePushes()).map((p) => p.changes)).toEqual([undefined])

    await s1.dropPushes(1)
    await exec(s1, "INSERT INTO dishes VALUES ('e', '5')")
    await exec(s1, "INSERT INTO dishes VALUES ('f', '6')")
    await waitFor(() => names(sub.rows()).includes('e=5 f=6'), { label: 'gap pulled' })
  })

  it('a node evicted after a lost push catches up on resume, its hibernated subscription intact', async () => {
    const { node, source, subscribe, lifecycle } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE)
    const sub = subscribe()
    await sub.ready

    await s1.dropPushes(1)
    await exec(s1, "INSERT INTO dishes VALUES ('a', 'lost')")
    await evictDurableObject(node)
    await node.resume(['s1'])
    await waitFor(() => names(sub.rows()) === 'a=lost', { label: 'resumed' })
    expect(lifecycle).toEqual([])
  })

  it('resume with no ids catches up every source the node keeps a clock for', async () => {
    const { node, source, subscribe } = setup()
    const [s1, s2] = [source('s1'), source('s2')]
    await Promise.all([exec(s1, CREATE), exec(s2, CREATE)])
    const [one, two] = [subscribe('s1'), subscribe('s2')]
    await Promise.all([one.ready, two.ready])

    await Promise.all([s1.dropPushes(1), s2.dropPushes(1)])
    await Promise.all([exec(s1, "INSERT INTO dishes VALUES ('a', 'one')"), exec(s2, "INSERT INTO dishes VALUES ('b', 'two')")])
    await evictDurableObject(node)
    await node.resume()
    await waitFor(() => names(one.rows()) === 'a=one' && names(two.rows()) === 'b=two', { label: 'both resumed' })
  })

  it('a dropped table wipes: onWipe closes the socket 4409, and the resubscribe reads a fresh snapshot', async () => {
    const { node, source, subscribe, lifecycle } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE, "INSERT INTO dishes VALUES ('a', 'old')")
    const sub = subscribe()
    await sub.ready

    await exec(s1, 'DROP TABLE dishes', CREATE, "INSERT INTO dishes VALUES ('z', 'new')")
    await waitFor(() => lifecycle.includes('reconnect'), { label: 'reconnect' })
    expect(lifecycle[0]).toBe('disconnect:4409')
    await waitFor(() => names(sub.rows()) === 'z=new', { label: 'fresh snapshot' })
    expect(await node.wipes()).toEqual(['s1'])
  })

  it('a source reset under a new epoch wipes too', async () => {
    const { node, source, subscribe, lifecycle } = setup()
    const s1 = source('s1')
    await exec(s1, CREATE, "INSERT INTO dishes VALUES ('a', 'old')")
    await exec(s1, "INSERT INTO dishes VALUES ('b', 'old')")
    const sub = subscribe()
    await sub.ready

    await s1.destroy()
    await exec(s1, CREATE, "INSERT INTO dishes VALUES ('n', 'new')")
    await waitFor(() => lifecycle.includes('reconnect'), { label: 'reconnect' })
    expect(lifecycle[0]).toBe('disconnect:4409')
    await waitFor(() => names(sub.rows()) === 'n=new', { label: 'fresh snapshot' })
    expect(await node.wipes()).toEqual(['s1'])
  })

  it('refuses a subscribe that does not pin storeId, and every write', async () => {
    const { client } = setup()
    const rows = client.collection('storeRows')
    await expect(rows.subscribe({ filter: eq('table', 'dishes') }).ready).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(rows.subscribe().ready).rejects.toMatchObject({ code: 'VALIDATION' })
    const row = { key: 's1:dishes:a', storeId: 's1', table: 'dishes', id: 'a', data: { id: 'a' } }
    await expect(rows.insert(row)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await client.collection('notes').insert({ id: 'n1', text: 'still writable' })
    expect(await client.collection('notes').query()).toEqual([{ id: 'n1', text: 'still writable' }])
  })
})
