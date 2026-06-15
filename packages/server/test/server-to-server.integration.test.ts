import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  roles: { user: {} }, // at least one role; this contract is about node<->node
  serverToServer: {
    rebalance: z.object({ shard: z.number() }),
  },
})

const h = createHarness()
afterEach(() => h.dispose())

function node(bus: MemoryBus) {
  return h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createInMemoryAdapter(bus),
  })
}

describe('serverToServer messaging', () => {
  it('delivers to other nodes and excludes the sender', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const bGot: Array<{ shard: number }> = []
    const aGot: Array<{ shard: number }> = []
    b.srv.onServer('rebalance', (d) => bGot.push(d))
    a.srv.onServer('rebalance', (d) => aGot.push(d))

    a.srv.emitServer('rebalance', { shard: 3 })

    await waitFor(() => bGot.length === 1)
    expect(bGot).toEqual([{ shard: 3 }])

    await tick(30)
    expect(aGot).toEqual([]) // sender does not receive its own emit
  })

  it('stops delivering after the listener unsubscribes', async () => {
    const bus = new MemoryBus()
    const a = await node(bus)
    const b = await node(bus)

    const got: Array<{ shard: number }> = []
    const off = b.srv.onServer('rebalance', (d) => got.push(d))

    a.srv.emitServer('rebalance', { shard: 1 })
    await waitFor(() => got.length === 1)

    off()
    a.srv.emitServer('rebalance', { shard: 2 })
    await tick(30)
    expect(got).toEqual([{ shard: 1 }])
  })
})
