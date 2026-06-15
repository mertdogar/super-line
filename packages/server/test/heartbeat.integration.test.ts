import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { Conn } from '@super-line/server'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: { clientToServer: { ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) } } },
  },
})

function authenticate() {
  return { role: 'user' as const, ctx: {} }
}

const h = createHarness()
afterEach(() => h.dispose())

describe('heartbeat (slice 2)', () => {
  it('records lastPingAt/lastPongAt as the heartbeat runs', async () => {
    const { srv, url } = await h.server(contract, { authenticate, heartbeat: { interval: 15 } })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })

    const client = h.client(contract, { url, role: 'user' })
    await client.ping({})
    await waitFor(() => srv.local.connections.length === 1)
    const conn = srv.local.connections[0] as Conn

    await waitFor(() => conn.lastPingAt !== undefined)
    await waitFor(() => conn.lastPongAt !== undefined)
    expect(conn.lastPongAt).toBeGreaterThanOrEqual(conn.connectedAt)
  })

  it('reaps a connection that misses maxMissed pongs and fires onDisconnect', async () => {
    let disconnected = 0
    const { srv, url } = await h.server(contract, {
      authenticate,
      heartbeat: { interval: 15, maxMissed: 1 },
      onDisconnect: () => {
        disconnected++
      },
    })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })

    // raw ws that never answers pings -> server should terminate it
    const raw = new WebSocket(`${url}/?role=user`, { autoPong: false })
    await new Promise<void>((resolve, reject) => {
      raw.on('open', () => resolve())
      raw.on('error', reject)
    })
    await waitFor(() => srv.local.connections.length === 1)

    await waitFor(() => srv.local.connections.length === 0)
    expect(disconnected).toBe(1)
    raw.terminate()
  })

  it('does not ping when heartbeat is disabled', async () => {
    const { srv, url } = await h.server(contract, { authenticate, heartbeat: false })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })

    const client = h.client(contract, { url, role: 'user' })
    await client.ping({})
    await waitFor(() => srv.local.connections.length === 1)
    const conn = srv.local.connections[0] as Conn

    await new Promise((r) => setTimeout(r, 60))
    expect(conn.lastPingAt).toBeUndefined()
    expect(conn.lastPongAt).toBeUndefined()
  })
})
