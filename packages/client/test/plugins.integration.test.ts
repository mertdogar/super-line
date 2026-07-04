import { afterEach, describe, expect, it } from 'vitest'
import { defineContract, type Schema } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { memoryStoreClient } from '@super-line/store-memory'
import { createLoopbackTransport } from '@super-line/transport-loopback'

// passthrough Standard Schema (client package has no zod dep) — validate returns the value unchanged
const s = (): Schema =>
  ({ '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } }) as unknown as Schema

const contract = defineContract({
  shared: {
    clientToServer: { hello: { input: s(), output: s() } },
    serverToClient: { confirm: { input: s(), output: s() } },
  },
  roles: { user: {} },
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const servers: SuperLineServer<typeof contract, { role: 'user'; ctx: {} }>[] = []
const clients: { close(): void }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

function serve(loop: ReturnType<typeof createLoopbackTransport>, onConn?: (id: string) => void) {
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    onConnection: (conn) => onConn?.(conn.id),
  })
  srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  servers.push(srv)
  return srv
}

describe('client plugins (phase 1 · client pair)', () => {
  it('fires onConnect once across host + plugins, and onDisconnect on close', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    const calls: string[] = []
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      onConnect: () => calls.push('host:connect'),
      onDisconnect: () => calls.push('host:disconnect'),
      plugins: [{ name: 'p', onConnect: () => calls.push('p:connect'), onDisconnect: () => calls.push('p:disconnect') }],
    })
    await cl.hello({})
    await waitFor(() => calls.includes('p:connect'))
    expect(calls).toEqual(['host:connect', 'p:connect']) // host first, then plugin order, once
    cl.close()
    await waitFor(() => calls.includes('p:disconnect'))
    expect(calls).toContain('host:disconnect')
  })

  it('a client plugin implement handler answers a server→client request', async () => {
    const loop = createLoopbackTransport()
    let connId = ''
    const srv = serve(loop, (id) => (connId = id))
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      plugins: [{ name: 'p', implement: { confirm: async (input) => ({ ok: (input as { q: string }).q === 'go' }) } }],
    })
    clients.push(cl)
    await cl.hello({})
    await waitFor(() => connId !== '')
    expect(await srv.toConn(connId).request('confirm', { q: 'go' })).toEqual({ ok: true })
  })

  it('throws when two sources implement the same server→client handler', () => {
    const loop = createLoopbackTransport()
    expect(() =>
      createSuperLineClient(contract, {
        transport: loop.client(),
        role: 'user',
        plugins: [
          { name: 'a', implement: { confirm: async () => ({ ok: true }) } },
          { name: 'b', implement: { confirm: async () => ({ ok: false }) } },
        ],
      }),
    ).toThrow(/duplicate server→client handler.*confirm/i)
  })

  it('merges a plugin-contributed client store into client.store(name)', () => {
    const loop = createLoopbackTransport()
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      plugins: [{ name: 'p', stores: { plog: memoryStoreClient() } }],
    })
    clients.push(cl)
    expect(() => cl.store('plog')).not.toThrow()
    expect(() => cl.store('nope')).toThrow(/not configured/i)
  })
})
