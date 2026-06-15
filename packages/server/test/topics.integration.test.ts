import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness } from './harness.js'

const contract = defineContract({
  shared: {
    serverToClient: {
      announce: { payload: z.object({ msg: z.string() }), subscribe: true }, // shared topic
    },
  },
  roles: {
    user: {
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
        secret: { payload: z.object({ data: z.string() }), subscribe: true },
      },
    },
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
  it('delivers a role topic to subscribers and stops after unsubscribe', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    const client = h.client(contract, { url, role: 'user' })

    const received: Array<{ symbol: string; price: number }> = []
    const sub = client.subscribe('prices', (p) => received.push(p))
    await sub.ready

    srv.forRole('user').publish('prices', { symbol: 'AAPL', price: 1 })
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ symbol: 'AAPL', price: 1 }])

    sub.unsubscribe()
    await tick(50) // let the unsub reach the server before publishing again
    srv.forRole('user').publish('prices', { symbol: 'AAPL', price: 2 })
    await tick(50)
    expect(received).toHaveLength(1)
  })

  it('delivers a shared topic via srv.publish', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    const client = h.client(contract, { url, role: 'user' })

    const received: Array<{ msg: string }> = []
    await client.subscribe('announce', (a) => received.push(a)).ready

    srv.publish('announce', { msg: 'hello all' })
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ msg: 'hello all' }])
  })

  it('rejects a denied subscribe and delivers nothing', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      authorizeSubscribe: (topic) => topic !== 'secret',
    })
    const client = h.client(contract, { url, role: 'user' })

    const received: unknown[] = []
    const sub = client.subscribe('secret', (d) => received.push(d))
    await expect(sub.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })

    srv.forRole('user').publish('secret', { data: 'x' })
    await tick(50)
    expect(received).toHaveLength(0)
  })
})
