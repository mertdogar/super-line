import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { Conn } from '@super-line/server'
import { createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  messages: {
    hang: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
  },
  events: {},
  topics: {
    prices: z.object({ symbol: z.string(), price: z.number() }),
  },
})

const h = createHarness()
afterEach(() => h.dispose())

describe('client reconnect', () => {
  it('auto-reconnects and re-subscribes topics after an abrupt drop', async () => {
    let lastConn: Conn<unknown> | undefined
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({}),
      onConnection: (c) => {
        lastConn = c
      },
    })
    srv.implement({ hang: () => new Promise<never>(() => {}) })

    const client = h.client(contract, { url, reconnectBaseMs: 10, reconnectMaxMs: 50 })
    const received: Array<{ symbol: string; price: number }> = []
    await client.subscribe('prices', (p) => received.push(p)).ready

    srv.publish('prices', { symbol: 'A', price: 1 })
    await waitFor(() => received.length === 1)

    const firstConn = lastConn
    firstConn!.ws.terminate() // simulate a network drop

    await waitFor(() => lastConn !== firstConn && client.connected, 3000)

    srv.publish('prices', { symbol: 'B', price: 2 })
    await waitFor(() => received.length === 2, 3000)
    expect(received[1]).toEqual({ symbol: 'B', price: 2 })
  })

  it('rejects in-flight requests with DISCONNECTED when the connection drops', async () => {
    let lastConn: Conn<unknown> | undefined
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({}),
      onConnection: (c) => {
        lastConn = c
      },
    })
    srv.implement({ hang: () => new Promise<never>(() => {}) })

    const client = h.client(contract, { url, reconnectBaseMs: 10 })
    await waitFor(() => client.connected)

    const inflight = client.hang({})
    await tick(20) // ensure the request was sent
    lastConn!.ws.terminate()

    await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
})
