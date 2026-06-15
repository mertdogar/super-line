import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createHarness } from './harness.js'

const contract = defineContract({
  shared: {
    serverToClient: { message: { payload: z.object({ text: z.string() }) } }, // shared event for rooms
  },
  roles: {
    user: {
      clientToServer: {
        join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
      },
    },
  },
})

const h = createHarness()
afterEach(() => h.dispose())

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 1000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick()
  }
}

async function node(bus: MemoryBus) {
  const n = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createInMemoryAdapter(bus),
  })
  n.srv.implement({
    user: {
      join: async ({ room }, _ctx, conn) => {
        n.srv.room(room).add(conn)
        return { ok: true }
      },
    },
  })
  return n
}

describe('cross-node fan-out (two servers, one bus)', () => {
  it('delivers a topic publish from node B to a subscriber on node A', async () => {
    const bus = new MemoryBus()
    const nodeA = await node(bus)
    const nodeB = await node(bus)

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const received: Array<{ symbol: string; price: number }> = []
    const sub = client.subscribe('prices', (p) => received.push(p))
    await sub.ready

    nodeB.srv.forRole('user').publish('prices', { symbol: 'MSFT', price: 5 })
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ symbol: 'MSFT', price: 5 }])
  })

  it('delivers a room broadcast from node B to a member on node A', async () => {
    const bus = new MemoryBus()
    const nodeA = await node(bus)
    const nodeB = await node(bus)

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))

    await client.join({ room: 'lobby' })
    nodeB.srv.room('lobby').broadcast('message', { text: 'cross-node hi' })

    await waitFor(() => got.length === 1)
    expect(got).toEqual([{ text: 'cross-node hi' }])
  })
})
