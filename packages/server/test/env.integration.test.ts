import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'

// Connection `env` — server-vended, client-visible per-connection state (ADR-0012).
const contract = defineContract({
  roles: {
    agent: {
      env: z.object({ projectId: z.string(), ommaApiKey: z.string() }),
      clientToServer: { ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    },
    plain: {
      clientToServer: { ping: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    },
  },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

function boot() {
  const loopback = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    identify: (conn) => (conn.ctx as { userId?: string }).userId,
    authenticate: (h) => {
      if (h.query.role === 'plain') return { role: 'plain' as const, ctx: {} }
      return { role: 'agent' as const, ctx: { userId: 'u1' }, env: { projectId: 'p1', ommaApiKey: 'k1' } }
    },
  })
  cleanups.push(() => srv.close())
  const connect = (role: 'agent' | 'plain') => {
    const client = createSuperLineClient(contract, { transport: loopback.client(), role })
    cleanups.unshift(() => client.close())
    return client
  }
  return { srv, connect }
}

describe('connection env (ADR-0012)', () => {
  it('seeds env from authenticate and resolves ready with the typed value', async () => {
    const { connect } = boot()
    const client = connect('agent')
    await client.env.ready
    expect(client.env.current).toEqual({ projectId: 'p1', ommaApiKey: 'k1' })
  })

  it('resolves ready with null for a role that declares no env', async () => {
    const { connect } = boot()
    const client = connect('plain')
    await client.env.ready
    expect(client.env.current).toBeNull()
  })

  it('pushes a live env update to the client and fires subscribers', async () => {
    const { srv, connect } = boot()
    const client = connect('agent')
    await client.env.ready
    const seen: unknown[] = []
    client.env.subscribe((e) => seen.push(e))
    srv.local.connections[0]!.setEnv({ projectId: 'p2', ommaApiKey: 'k2' })
    await tick()
    expect(client.env.current).toEqual({ projectId: 'p2', ommaApiKey: 'k2' })
    expect(seen.at(-1)).toEqual({ projectId: 'p2', ommaApiKey: 'k2' })
  })

  it('validates conn.setEnv against the role env schema (rejects a bad shape)', async () => {
    const { srv, connect } = boot()
    const client = connect('agent')
    await client.env.ready
    const conn = srv.local.connections[0]!
    expect(() => conn.setEnv({ projectId: 'p2' } as never)).toThrow()
    // the bad write never reached the client
    expect(client.env.current).toEqual({ projectId: 'p1', ommaApiKey: 'k1' })
  })

  it('updates a user’s connection via srv.toUser().setEnv', async () => {
    const { srv, connect } = boot()
    const client = connect('agent')
    await client.env.ready
    srv.toUser('u1').setEnv({ projectId: 'p3', ommaApiKey: 'k3' })
    await tick()
    expect(client.env.current).toEqual({ projectId: 'p3', ommaApiKey: 'k3' })
  })
})
