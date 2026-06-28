import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { defineContract, type ClientTransport } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer } from '@super-line/server'
import { syncStoreClient } from '@super-line/store-sync'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { libsqlSyncStore } from '../src/index.js'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })
const rules = { alice: { read: true, write: true }, bob: { read: true, write: true } }
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function poll(pred: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('poll timeout')
    await sleep(10)
  }
}

const cleanups: Array<() => Promise<void> | void> = []
let dir: string
const fileUrl = (): string => `file:${join(dir, 'shared.db')}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-libsql-cluster-'))
})
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
  rmSync(dir, { recursive: true, force: true })
})

const decode = (state: string | undefined): unknown => {
  if (state === undefined) return undefined
  const r = syncStoreClient().open('probe')
  r.seed(state)
  return r.getSnapshot()
}
const rowState = async (url: string, id: string): Promise<string | undefined> => {
  const c = createClient({ url })
  const { rows } = await c.execute({ sql: 'SELECT state FROM resources WHERE id = ?', args: [id] })
  c.close()
  return rows[0]?.state as string | undefined
}

async function node(url: string, bus: MemoryBus) {
  const loop = createLoopbackTransport()
  const store = await libsqlSyncStore({ url, debounceMs: 20 })
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    adapter: createInMemoryAdapter(bus),
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: store },
  })
  cleanups.push(() => srv.close())
  cleanups.push(() => store.close?.())
  return { srv, store, transport: loop.client() }
}

function client(transport: ClientTransport, uid: string) {
  const cl = createSuperLineClient(contract, {
    transport,
    role: 'user',
    params: { uid },
    stores: { docs: syncStoreClient() },
  })
  cleanups.push(() => cl.close())
  return cl
}

describe('libsqlSyncStore — multi-node over a shared libsql (B4)', () => {
  it('a CRDT edit on node A converges on node B and is persisted to the shared row', async () => {
    const url = fileUrl()
    const bus = new MemoryBus()
    const a = await node(url, bus)
    await a.srv.store('docs').create('d', { v: 0 }, rules) // persists the initial row
    const b = await node(url, bus) // boots later → rehydrates 'd' from the shared row (its doc descends from A's)

    const hb = client(b.transport, 'bob').store('docs').open('d')
    await hb.ready
    expect(hb.getSnapshot()).toEqual({ v: 0 })

    const ha = client(a.transport, 'alice').store('docs').open('d')
    await ha.ready
    ha.update({ v: 1 })

    await poll(() => eq(hb.getSnapshot(), { v: 1 })) // fan-out + CRDT merge reached B's subscriber
    expect(decode((await b.store.read('d'))?.data as string)).toEqual({ v: 1 }) // B's replica converged

    await poll(async () => eq(decode(await rowState(url, 'd')), { v: 1 })) // a debounced flush persisted it
  })

  it('a delete on node A fans out: node B drops its doc, the shared row is gone, a subscribed client sees deleted', async () => {
    const url = fileUrl()
    const bus = new MemoryBus()
    const a = await node(url, bus)
    await a.srv.store('docs').create('d', { v: 0 }, rules)
    const b = await node(url, bus)

    const hb = client(b.transport, 'bob').store('docs').open('d')
    await hb.ready
    hb.update({ v: 7 }) // schedules a debounced flush on B that must NOT resurrect the row after delete

    await a.srv.store('docs').delete('d') // server handle → publishes the sdel fan-out

    await poll(() => hb.deleted) // subscribed client on B learns of the deletion
    expect(await b.store.read('d')).toBeUndefined() // B dropped its replica (relay delete)
    await poll(async () => (await rowState(url, 'd')) === undefined) // shared row gone, not resurrected
  })
})
