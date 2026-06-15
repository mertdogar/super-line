import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SocketError } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
        blocked: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
      },
    },
  },
})

const h = createHarness()
afterEach(() => h.dispose())

describe('middleware + lifecycle hooks', () => {
  it('runs middleware in order around the handler and can short-circuit', async () => {
    const order: string[] = []
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      use: [
        async (_ctx, info, next) => {
          order.push(`a:before:${info.name}`)
          await next()
          order.push('a:after')
        },
        async (_ctx, info, next) => {
          if (info.name === 'blocked') throw new SocketError('FORBIDDEN', 'no')
          order.push('b')
          await next()
        },
      ],
    })
    srv.implement({
      user: {
        hello: async () => {
          order.push('handler')
          return { ok: true }
        },
        blocked: async () => {
          order.push('should-not-run')
          return { ok: true }
        },
      },
    })

    const client = h.client(contract, { url, role: 'user' })
    expect(await client.hello({})).toEqual({ ok: true })
    expect(order).toEqual(['a:before:hello', 'b', 'handler', 'a:after'])

    await expect(client.blocked({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(order).not.toContain('should-not-run')
  })

  it('invokes onConnection and onDisconnect', async () => {
    const events: string[] = []
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: () => events.push('connect'),
      onDisconnect: () => events.push('disconnect'),
    })
    srv.implement({
      user: {
        hello: async () => ({ ok: true }),
        blocked: async () => ({ ok: true }),
      },
    })

    const client = h.client(contract, { url, role: 'user', reconnect: false })
    await client.hello({})
    expect(events).toContain('connect')

    client.close()
    await waitFor(() => events.includes('disconnect'))
  })

  it('applies middleware to subscribe and reports errors via onError', async () => {
    const errors: Array<{ name: string; kind: string }> = []
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      use: [
        async (_ctx, info, next) => {
          if (info.kind === 'subscribe' && info.name === 'feed') {
            throw new SocketError('FORBIDDEN', 'blocked-sub')
          }
          await next()
        },
      ],
      onError: (_err, info) => errors.push({ name: info.name, kind: info.kind }),
    })
    srv.implement({
      user: {
        hello: async () => ({ ok: true }),
        blocked: async () => ({ ok: true }),
      },
    })

    const client = h.client(contract, { url, role: 'user' })
    const sub = client.subscribe('feed', () => {})
    await expect(sub.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(errors).toContainEqual({ name: 'feed', kind: 'subscribe' })
  })
})
