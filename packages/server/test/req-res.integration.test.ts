import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SocketError } from '@super-line/core'
import { createSocketServer } from '@super-line/server'
import { createClient } from '@super-line/client'

const contract = defineContract({
  messages: {
    echo: {
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string(), at: z.number() }),
    },
    boom: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {},
  topics: {},
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  // LIFO teardown: client closes before the http server it connected to.
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function boot() {
  const server = http.createServer()
  const srv = createSocketServer<{ user: { id: string } }>({
    server,
    authenticate: () => ({ user: { id: 'u1' } }),
  })
  srv.implement(contract, {
    echo: async ({ text }, ctx) => ({ text: `${text}:${ctx.user.id}`, at: 42 }),
    boom: async () => {
      throw new SocketError('FORBIDDEN', 'nope')
    },
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  const client = createClient(contract, { url: `ws://127.0.0.1:${port}` })
  // pushed in creation order; afterEach reverses so the client (created last) closes first
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  cleanups.push(() => client.close())
  return { client }
}

describe('req/res over loopback', () => {
  it('round-trips a typed request and response', async () => {
    const { client } = await boot()
    const res = await client.echo({ text: 'hi' })
    expect(res).toEqual({ text: 'hi:u1', at: 42 })
  })

  it('rejects with a typed SocketError when the handler throws', async () => {
    const { client } = await boot()
    await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'nope' })
  })

  it('rejects with VALIDATION on bad input', async () => {
    const { client } = await boot()
    // @ts-expect-error wrong input type is a compile-time error too
    await expect(client.echo({ text: 123 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
