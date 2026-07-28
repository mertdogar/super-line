import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineContract } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { memoryCollections } from '@super-line/collections-memory'
import { DEVTOOLS_GLOBAL, devtoolsPlugin, devtoolsRegistry } from '@super-line/plugin-devtools'
import * as z from 'zod'

const contract = defineContract({
  collections: { notes: { schema: z.object({ id: z.string(), done: z.boolean() }), key: 'id' } },
  shared: { clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } } },
  roles: { user: {} },
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const resetPage = () => void delete (globalThis as Record<string, unknown>)[DEVTOOLS_GLOBAL]
beforeEach(resetPage)

const teardown: Array<() => unknown> = []
afterEach(async () => {
  for (const t of teardown.splice(0).reverse()) await t()
  resetPage()
})

function setup() {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    collections: memoryCollections(),
    policies: { notes: { read: () => undefined, write: () => true } },
  })
  srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  const cl = createSuperLineClient(contract, {
    transport: loop.client(),
    role: 'user',
    plugins: [devtoolsPlugin()],
  })
  teardown.push(() => cl.close(), () => srv.close())
  return { srv, cl }
}

const reg = () => devtoolsRegistry()!

describe('devtoolsPlugin on a real client', () => {
  it('buffers a real request and its response, paired by the wire correlation id', async () => {
    const { cl } = setup()
    await cl.hello({})

    const { records } = reg().drain(0)
    const req = records.find((r) => r.event.k === 'frame' && r.event.f.t === 'req')
    const res = records.find((r) => r.event.k === 'frame' && r.event.f.t === 'res')
    expect(req).toBeDefined()
    expect(res).toBeDefined()
    // nothing pairs these for the reader — that is deliberately the reader's fold
    const reqFrame = (req!.event as { f: { i: number; m: string } }).f
    const resFrame = (res!.event as { f: { i: number } }).f
    expect(reqFrame.m).toBe('hello')
    expect(resFrame.i).toBe(reqFrame.i)
    expect(res!.ts).toBeGreaterThanOrEqual(req!.ts)
  })

  it('records the per-subscription routing decision a row change produced', async () => {
    const { srv, cl } = setup()
    const sub = cl.collection('notes').subscribe({ filter: { op: 'eq', field: 'done', value: false } as never })
    await sub.ready

    await srv.collection('notes').insert({ id: 'n1', done: false }) // matches
    await waitFor(() =>
      reg()
        .drain(0, 1000)
        .records.some((r) => r.event.k === 'route' && r.event.decision === 'insert'),
    )

    await srv.collection('notes').update({ id: 'n1', done: true }) // no longer matches
    await waitFor(() =>
      reg()
        .drain(0, 1000)
        .records.some((r) => r.event.k === 'route' && r.event.decision === 'left-filter'),
    )

    // "left the filter" is not "was deleted", and the wire frame alone cannot tell you which happened
    const decisions = reg()
      .drain(0, 1000)
      .records.flatMap((r) => (r.event.k === 'route' ? [r.event.decision] : []))
    expect(decisions).toContain('insert')
    expect(decisions).toContain('left-filter')
    expect(decisions).not.toContain('delete')
  })

  it('serves live client state through the registry while the client runs', async () => {
    const { srv, cl } = setup()
    await srv.collection('notes').insert({ id: 'n1', done: false })
    const sub = cl.collection('notes').subscribe({})
    await sub.ready

    const clientId = reg().clients()[0]!.clientId
    const snap = reg().inspect(clientId)!
    expect(snap.alive).toBe(true)
    expect(snap.collections).toHaveLength(1)
    expect(snap.collections[0]!.rows).toEqual([{ id: 'n1', done: false }])
  })

  it('keeps a closed client listed as dead, with its records intact', async () => {
    const { cl } = setup()
    await cl.hello({})
    const before = reg().drain(0).records.length
    cl.close()

    const [summary] = reg().clients()
    expect(summary!.alive).toBe(false)
    expect(reg().drain(0).records.length).toBeGreaterThanOrEqual(before)
  })

  it('keeps two concurrently-live clients in one ordered stream', async () => {
    const { cl } = setup()
    const { cl: other } = setup()
    await cl.hello({})
    await other.hello({})

    const { records, clients } = reg().drain(0, 1000)
    expect(clients).toHaveLength(2)
    const seen = new Set(records.map((r) => r.clientId))
    expect(seen.size).toBe(2)
    // one monotonic sequence across both, which is what makes the handover readable
    expect(records.map((r) => r.seq)).toEqual([...records].sort((a, b) => a.seq - b.seq).map((r) => r.seq))
  })
})
