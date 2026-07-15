import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, jsonSerializer } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter, type MiddlewareInfo } from '@super-line/server'
import { createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  shared: {
    serverToClient: {
      announce: { payload: z.object({ msg: z.string() }), subscribe: true },
    },
  },
  roles: { user: {} },
})

const h = createHarness()
afterEach(() => h.dispose())

function node(bus: MemoryBus, onError?: (error: unknown, info: MiddlewareInfo) => void) {
  return h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createInMemoryAdapter(bus),
    onError,
  })
}

describe('cluster event bus', () => {
  it('delivers to every node including the publisher (local echo), tagging the origin', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const aGot: Array<{ msg: string; from: string }> = []
    const bGot: Array<{ msg: string; from: string }> = []
    a.srv.subscribe('announce', (d, m) => aGot.push({ msg: d.msg, from: m.from }))
    b.srv.subscribe('announce', (d, m) => bGot.push({ msg: d.msg, from: m.from }))

    a.srv.publish('announce', { msg: 'hi' })

    // local echo fires synchronously in-process; the looped-back copy is deduped, so no double-fire
    expect(aGot).toEqual([{ msg: 'hi', from: a.srv.nodeId }])

    await waitFor(() => bGot.length === 1)
    expect(bGot).toEqual([{ msg: 'hi', from: a.srv.nodeId }])

    await tick(30)
    expect(aGot).toHaveLength(1)
    expect(bGot).toHaveLength(1)
  })

  it('supports self-exclusion via meta.from', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const aGot: Array<{ msg: string }> = []
    const bGot: Array<{ msg: string }> = []
    a.srv.subscribe('announce', (d, m) => {
      if (m.from === a.srv.nodeId) return
      aGot.push(d)
    })
    b.srv.subscribe('announce', (d, m) => {
      if (m.from === b.srv.nodeId) return
      bGot.push(d)
    })

    a.srv.publish('announce', { msg: 'x' })
    await waitFor(() => bGot.length === 1)
    await tick(20)

    expect(aGot).toEqual([]) // a excluded its own publish
    expect(bGot).toEqual([{ msg: 'x' }])
  })

  it('fans out to multiple local subscribers and stops after unsubscribe', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const got1: Array<{ msg: string }> = []
    const got2: Array<{ msg: string }> = []
    b.srv.subscribe('announce', (d) => got1.push(d))
    const off = b.srv.subscribe('announce', (d) => got2.push(d))

    a.srv.publish('announce', { msg: '1' })
    await waitFor(() => got1.length === 1 && got2.length === 1)

    off()
    a.srv.publish('announce', { msg: '2' })
    await waitFor(() => got1.length === 2)
    await tick(20)

    expect(got1).toEqual([{ msg: '1' }, { msg: '2' }])
    expect(got2).toEqual([{ msg: '1' }]) // off() stopped the second listener
  })

  it('isolates a throwing listener and routes the error to onError', async () => {
    const bus = new MemoryBus()
    const errs: Array<{ name: string; kind: string }> = []
    const a = await node(bus)
    const b = await node(bus, (_e, info) => errs.push({ name: info.name, kind: info.kind }))

    const got: Array<{ msg: string }> = []
    b.srv.subscribe('announce', () => {
      throw new Error('boom')
    })
    b.srv.subscribe('announce', (d) => got.push(d))

    a.srv.publish('announce', { msg: 'ok' })
    await waitFor(() => got.length === 1)

    expect(got).toEqual([{ msg: 'ok' }]) // sibling still fired despite the throw
    expect(errs).toEqual([{ name: 'announce', kind: 'event' }])
  })

  it('validates inbound remote payloads and drops invalid ones to onError', async () => {
    const bus = new MemoryBus()
    const errs: Array<{ name: string }> = []
    const b = await node(bus, (_e, info) => errs.push({ name: info.name }))

    const got: unknown[] = []
    b.srv.subscribe('announce', (d) => got.push(d))

    // a misbehaving/older node publishes a malformed payload straight onto the bus channel
    const raw = createInMemoryAdapter(bus)
    void raw.publish(
      't:shared:announce',
      jsonSerializer.encode({ t: 'pub', c: 'announce', d: { msg: 123 }, nd: 'other-node' }),
    )

    await waitFor(() => errs.length === 1)
    await tick(20)

    expect(got).toEqual([]) // invalid payload never reached the listener
    expect(errs).toEqual([{ name: 'announce' }])
  })

  it('delivers bus publishes to subscribed clients on any node', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const client = h.client(contract, { url: a.url, role: 'user' })
    const got: Array<{ msg: string }> = []
    const sub = client.subscribe('announce', (d) => got.push(d))
    await sub.ready

    b.srv.publish('announce', { msg: 'to-client' }) // published on b, client is on a
    await waitFor(() => got.length === 1)

    expect(got).toEqual([{ msg: 'to-client' }])
  })
})
