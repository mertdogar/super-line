import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { createHarness } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: {
      ping: { input: z.object({}), output: z.object({ pong: z.boolean() }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        echo: {
          input: z.object({ text: z.string() }),
          output: z.object({ text: z.string(), at: z.number() }),
        },
        boom: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})

const h = createHarness()
afterEach(() => h.dispose())

async function boot() {
  const { srv, url } = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: { id: 'u1' } }),
  })
  srv.implement({
    shared: { ping: async () => ({ pong: true }) },
    user: {
      echo: async ({ text }, ctx) => ({ text: `${text}:${ctx.id}`, at: 42 }),
      boom: async () => {
        throw new SuperLineError('FORBIDDEN', 'nope')
      },
    },
  })
  return h.client(contract, { url, role: 'user' })
}

describe('req/res over loopback', () => {
  it('round-trips a typed request and response', async () => {
    const client = await boot()
    expect(await client.echo({ text: 'hi' })).toEqual({ text: 'hi:u1', at: 42 })
  })

  it('serves a shared request from any role', async () => {
    const client = await boot()
    expect(await client.ping({})).toEqual({ pong: true })
  })

  it('rejects with a typed SuperLineError when the handler throws', async () => {
    const client = await boot()
    await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'nope' })
  })

  it('rejects with VALIDATION on bad input', async () => {
    const client = await boot()
    // @ts-expect-error wrong input type is a compile-time error too
    await expect(client.echo({ text: 123 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
