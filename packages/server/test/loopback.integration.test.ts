import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer, type SuperLinePlugin } from '@super-line/server'
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

  it('uses an authenticator-provided connection id', async () => {
    const loopback = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {}, connectionId: 'session-1' }),
    })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    cleanups.unshift(() => client.close())
    cleanups.push(() => srv.close())
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })

    await client.echo({ text: 'connect' })

    expect(srv.local.connections[0]?.id).toBe('session-1')
  })

  it('rejects a duplicate authenticator-provided connection id without replacing the live connection', async () => {
    const loopback = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {}, connectionId: 'session-1' }),
    })
    const first = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    cleanups.unshift(() => first.close())
    cleanups.push(() => srv.close())
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    await first.echo({ text: 'first' })

    const closeCodes: number[] = []
    const duplicate = loopback.client().connect(
      {},
      {
        onOpen: () => {},
        onMessage: () => {},
        onClose: (code) => closeCodes.push(code),
        onDrain: () => {},
      },
    )
    cleanups.unshift(() => duplicate.close())
    await waitFor(() => closeCodes.length > 0)

    expect(closeCodes).toEqual([1008])
    expect(srv.local.connections.map((conn) => conn.id)).toEqual(['session-1'])
    await expect(first.echo({ text: 'still live' })).resolves.toEqual({ text: 'still live' })
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

  it('constructs without a `process` global (browser-safe)', () => {
    // Models a browser: no `process`. The server reads
    // process.env.SUPER_LINE_NODE_NAME for an optional node name and must not throw.
    const g = globalThis as Record<string, unknown>
    const saved = g.process
    delete g.process
    try {
      const loopback = createLoopbackTransport()
      const srv = createSuperLineServer(contract, {
        transports: [loopback.server],
        authenticate: () => ({ role: 'user' as const, ctx: {} }),
      })
      cleanups.push(() => srv.close())
      expect(srv.nodeId).toBeTruthy()
    } finally {
      g.process = saved
    }
  })

  it('exposes a configured stable node key', () => {
    const loopback = createLoopbackTransport()
    let pluginNodeKey: string | undefined
    const plugin: SuperLinePlugin = {
      name: 'node-key',
      setup: (ctx) => {
        pluginNodeKey = ctx.nodeKey
      },
    }
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      nodeKey: 'chat-replica-1',
      plugins: [plugin],
    })
    cleanups.push(() => srv.close())

    expect(srv.nodeKey).toBe('chat-replica-1')
    expect(pluginNodeKey).toBe('chat-replica-1')
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

  it('notifies plugins after a confirmed heartbeat pong', async () => {
    const loopback = createLoopbackTransport()
    const seen: number[] = []
    const plugin: SuperLinePlugin = {
      name: 'heartbeat',
      onHeartbeat: (_conn, _ctx, at) => {
        seen.push(at)
      },
    }
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      heartbeat: { interval: 15 },
      plugins: [plugin],
    })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    cleanups.unshift(() => client.close())
    cleanups.push(() => srv.close())
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })

    await client.echo({ text: 'x' })
    await waitFor(() => seen.length > 0)

    expect(seen[0]).toBeGreaterThanOrEqual(srv.local.connections[0]!.connectedAt)
  })

  it('routes heartbeat hook failures to onError without breaking the connection', async () => {
    const loopback = createLoopbackTransport()
    const errors: Array<{ message: string; kind: string; name: string }> = []
    const plugin: SuperLinePlugin = {
      name: 'failing-heartbeat',
      onHeartbeat: async () => {
        throw new Error('heartbeat write failed')
      },
      onError: (error, info) => {
        errors.push({ message: (error as Error).message, kind: info.kind, name: info.name })
      },
    }
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      heartbeat: { interval: 15 },
      plugins: [plugin],
    })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    cleanups.unshift(() => client.close())
    cleanups.push(() => srv.close())
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })

    await client.echo({ text: 'before heartbeat' })
    await waitFor(() => errors.length > 0)
    expect(errors[0]).toEqual({ message: 'heartbeat write failed', kind: 'heartbeat', name: 'onHeartbeat' })
    await expect(client.echo({ text: 'after heartbeat' })).resolves.toEqual({ text: 'after heartbeat' })
  })
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(5)
  }
}
