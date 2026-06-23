import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { createHarness } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: {
      ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
    },
  },
  roles: { user: {} },
})

const h = createHarness()
afterEach(() => h.dispose())

describe('transport identity', () => {
  it('threads the websocket wire onto conn.transport and the cluster descriptor', async () => {
    let seen: string | undefined
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (conn) => {
        seen = conn.transport
      },
    })
    srv.implement({ shared: { ping: async () => ({ ok: true }) }, user: {} })

    const client = h.client(contract, { url, role: 'user' })
    await client.ping({}) // a served request implies the conn was accepted + registered

    expect(seen).toBe('websocket')
    const conns = await srv.cluster.connections()
    expect(conns.map((c) => c.transport)).toEqual(['websocket'])
  })

  it('reflects the actual transport (loopback), not a hard-coded constant', async () => {
    const loopback = createLoopbackTransport()
    let seen: string | undefined
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (conn) => {
        seen = conn.transport
      },
    })
    srv.implement({ shared: { ping: async () => ({ ok: true }) }, user: {} })

    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    await client.ping({})

    expect(seen).toBe('loopback')
    const conns = await srv.cluster.connections()
    expect(conns.map((c) => c.transport)).toEqual(['loopback'])

    await client.close()
    await srv.close()
  })
})
