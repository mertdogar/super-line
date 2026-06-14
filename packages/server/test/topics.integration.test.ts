import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness } from './harness.js'

const contract = defineContract({
  messages: {},
  events: {},
  topics: {
    prices: z.object({ symbol: z.string(), price: z.number() }),
    secret: z.object({ data: z.string() }),
  },
})

const h = createHarness()
afterEach(() => h.dispose())

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 1000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(5)
  }
}

describe('topics pub/sub', () => {
  it('delivers published messages to subscribers and stops after unsubscribe', async () => {
    const { srv, url } = await h.server(contract, { authenticate: () => ({}) })
    const client = h.client(contract, { url })

    const received: Array<{ symbol: string; price: number }> = []
    const sub = client.subscribe('prices', (p) => received.push(p))
    await sub.ready

    srv.publish('prices', { symbol: 'AAPL', price: 1 })
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ symbol: 'AAPL', price: 1 }])

    sub.unsubscribe()
    await tick(50) // let the unsub reach the server before publishing again
    srv.publish('prices', { symbol: 'AAPL', price: 2 })
    await tick(50)
    expect(received).toHaveLength(1)
  })

  it('rejects a denied subscribe and delivers nothing', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({}),
      authorizeSubscribe: (topic) => topic !== 'secret',
    })
    const client = h.client(contract, { url })

    const received: unknown[] = []
    const sub = client.subscribe('secret', (d) => received.push(d))
    await expect(sub.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })

    srv.publish('secret', { data: 'x' })
    await tick(50)
    expect(received).toHaveLength(0)
  })
})
