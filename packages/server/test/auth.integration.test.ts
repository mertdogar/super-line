import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness } from './harness.js'

const contract = defineContract({
  messages: {
    ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
  },
  events: {},
  topics: {},
})

function authenticate(req: { url?: string }): { token: string } {
  const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
  if (token !== 'good') throw new Error('bad token')
  return { token }
}

const h = createHarness()
afterEach(() => h.dispose())

describe('auth at upgrade', () => {
  it('accepts a valid token and serves requests', async () => {
    const { srv, url } = await h.server(contract, { authenticate })
    srv.implement({ ping: async () => ({ ok: true }) })

    const client = h.client(contract, { url, params: { token: 'good' } })
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
    srv.implement({ ping: async () => ({ ok: true }) })

    // reconnect off: a 401 is indistinguishable from a drop over the WS API, so with
    // reconnect on the client would retry forever; off, the failure surfaces immediately.
    const client = h.client(contract, { url, params: { token: 'bad' }, reconnect: false })
    await expect(client.ping({})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(connections).toBe(0)
  })
})
