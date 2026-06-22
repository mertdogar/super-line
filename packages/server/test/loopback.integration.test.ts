import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'

// Proves the CORE works over a non-WebSocket transport — the interface proof (PLAN Q11).
const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
      },
      serverToClient: {
        tick: { payload: z.object({ n: z.number() }) },
        feed: { payload: z.object({ v: z.number() }), subscribe: true },
      },
    },
  },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function boot() {
  const loopback = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { name: h.query.name ?? 'anon' } }),
  })
  const client = createSuperLineClient(contract, {
    transport: loopback.client(),
    role: 'user',
    params: { name: 'alice' },
  })
  cleanups.unshift(() => client.close())
  cleanups.push(() => srv.close())
  return { srv, client }
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('super-line over the loopback transport', () => {
  it('round-trips a typed request', async () => {
    const { srv, client } = boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text: text.toUpperCase() }) } })
    const out = await client.echo({ text: 'hi' })
    expect(out).toEqual({ text: 'HI' })
  })

  it('passes handshake params through authenticate', async () => {
    const { srv, client } = boot()
    let seenName: string | undefined
    srv.implement({
      user: {
        echo: async ({ text }, ctx) => {
          seenName = (ctx as { name: string }).name
          return { text }
        },
      },
    })
    await client.echo({ text: 'x' })
    expect(seenName).toBe('alice')
  })

  it('pushes a server event to the connection', async () => {
    const { srv, client } = boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    const got: number[] = []
    client.on('tick', (d) => got.push(d.n))
    await client.echo({ text: 'connect' }) // ensure the conn is established server-side
    srv.local.connections[0]!.emit('tick', { n: 7 })
    await tick()
    expect(got).toEqual([7])
  })

  it('subscribes to a topic and receives a publish', async () => {
    const { srv, client } = boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    const got: number[] = []
    const sub = client.subscribe('feed', (d) => got.push(d.v))
    await sub.ready
    srv.forRole('user').publish('feed', { v: 42 })
    await tick()
    expect(got).toEqual([42])
  })

  it('answers heartbeat pings so the server records liveness', async () => {
    const loopback = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      heartbeat: { interval: 15 },
    })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    cleanups.unshift(() => client.close())
    cleanups.push(() => srv.close())
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    await client.echo({ text: 'x' })
    const conn = srv.local.connections[0]!
    await waitFor(() => conn.lastPongAt !== undefined)
    expect(conn.lastPongAt).toBeGreaterThanOrEqual(conn.connectedAt)
  })
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(5)
  }
}
