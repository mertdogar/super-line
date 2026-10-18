import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { createHarness } from './harness.js'

const contract = defineContract({
  roles: {
    user: {
      clientToServer: { ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    },
  },
})

function authenticate(h: { query: Record<string, string> }) {
  const token = h.query.token
  if (token !== 'good') throw new Error('bad token')
  return { role: 'user' as const, ctx: { token } }
}

const h = createHarness()
afterEach(() => h.dispose())

describe('auth at upgrade', () => {
  it('accepts a valid token and serves requests', async () => {
    const { srv, url } = await h.server(contract, { authenticate })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })

    const client = h.client(contract, { url, role: 'user', params: { token: 'good' } })
    expect(await client.ping({})).toEqual({ ok: true })
  })

  it('rejects a bad token at the upgrade without consuming a socket', async () => {
    let connections = 0
    const { srv, url } = await h.server(contract, {
      authenticate,
      onConnection: () => {
        connections++
      },
    })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })

    // reconnect off: a 401 is indistinguishable from a drop over the WS API, so with
    // reconnect on the client would retry forever; off, the failure surfaces immediately.
    const client = h.client(contract, {
      url,
      role: 'user',
      params: { token: 'bad' },
      reconnect: false,
    })
    await expect(client.ping({})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(connections).toBe(0)
  })

  it('a thrown UNAUTHORIZED closes 4401, and the client stops instead of retrying', async () => {
    let attempts = 0
    const { srv, url } = await h.server(contract, {
      authenticate: () => {
        attempts++
        throw new SuperLineError('UNAUTHORIZED', 'revoked')
      },
    })
    srv.implement({ user: { ping: async () => ({ ok: true }) } })
    const closes: number[] = []
    const client = h.client(contract, { url, role: 'user', reconnectBaseMs: 10, onDisconnect: (code) => closes.push(code) })
    await expect(client.ping({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await new Promise((r) => setTimeout(r, 200))
    expect(attempts).toBe(1)
    expect(closes).toEqual([4401])
  })
})
