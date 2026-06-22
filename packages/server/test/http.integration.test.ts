import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EventSource } from 'eventsource'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { httpServerTransport, httpClientTransport } from '@super-line/transport-http'

// Proves the CORE works over the HTTP transport (SSE + long-poll) — the interface proof for Step 2.
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

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function boot(
  mode: 'sse' | 'longpoll',
  serverOpts: { heartbeat?: { interval?: number; maxMissed?: number } | false } = {},
) {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(contract, {
    transports: [httpServerTransport({ server: httpServer })],
    authenticate: (h) => ({ role: 'user' as const, ctx: { name: h.query.name ?? 'anon' } }),
    ...serverOpts,
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as AddressInfo
  const client = createSuperLineClient(contract, {
    transport: httpClientTransport({ url: `http://127.0.0.1:${port}`, mode, EventSource }),
    role: 'user',
    params: { name: 'alice' },
  })
  cleanups.unshift(() => client.close())
  cleanups.push(() => srv.close())
  return { srv, client }
}

async function waitFor(pred: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(10)
  }
}

for (const mode of ['sse', 'longpoll'] as const) {
  describe(`super-line over the HTTP transport (${mode})`, () => {
    it('round-trips a typed request', async () => {
      const { srv, client } = await boot(mode)
      srv.implement({ user: { echo: async ({ text }) => ({ text: text.toUpperCase() }) } })
      const out = await client.echo({ text: 'hi' })
      expect(out).toEqual({ text: 'HI' })
    })

    it('passes handshake params through authenticate', async () => {
      const { srv, client } = await boot(mode)
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
      const { srv, client } = await boot(mode)
      srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
      const got: number[] = []
      client.on('tick', (d) => got.push(d.n))
      await client.echo({ text: 'connect' })
      srv.local.connections[0]!.emit('tick', { n: 7 })
      await waitFor(() => got.length === 1)
      expect(got).toEqual([7])
    })

    it('subscribes to a topic and receives a publish', async () => {
      const { srv, client } = await boot(mode)
      srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
      const got: number[] = []
      const sub = client.subscribe('feed', (d) => got.push(d.v))
      await sub.ready
      srv.forRole('user').publish('feed', { v: 42 })
      await waitFor(() => got.length === 1)
      expect(got).toEqual([42])
    })

    it('answers heartbeat pings so the server records liveness', async () => {
      const { srv, client } = await boot(mode, { heartbeat: { interval: 20 } })
      srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
      await client.echo({ text: 'connect' })
      const conn = srv.local.connections[0]!
      await waitFor(() => conn.lastPongAt !== undefined)
      expect(conn.lastPongAt).toBeGreaterThanOrEqual(conn.connectedAt)
    })

    it('reports connected and disconnects cleanly', async () => {
      const { srv, client } = await boot(mode)
      srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
      await client.echo({ text: 'x' })
      expect(client.connected).toBe(true)
      await waitFor(() => srv.local.connections.length === 1)
      client.close()
      await waitFor(() => srv.local.connections.length === 0)
    })
  })
}

// Type-only guard: the client proxy is the typed surface.
export type _Client = SuperLineClient<typeof contract, 'user'>
