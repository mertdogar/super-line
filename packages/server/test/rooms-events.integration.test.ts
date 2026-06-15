import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { Conn } from '@super-line/server'
import { createHarness } from './harness.js'

// `message` is a SHARED event so a mixed-role room can broadcast it to every member.
const contract = defineContract({
  shared: {
    serverToClient: {
      message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
        say: {
          input: z.object({ room: z.string(), text: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
})

const h = createHarness()
afterEach(() => h.dispose())

function next<T>(register: (cb: (data: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => register(resolve))
}

async function boot() {
  const { srv, url } = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: { id: 'u1' } }),
  })
  return { srv, url }
}

describe('rooms + events', () => {
  it('broadcasts a shared event to room members and not to outsiders', async () => {
    const { srv, url } = await boot()
    srv.implement({
      user: {
        join: async ({ room }, _ctx, conn) => {
          srv.room(room).add(conn)
          return { ok: true }
        },
        say: async ({ room, text }, ctx) => {
          srv.room(room).broadcast('message', { room, text, from: ctx.id })
          return { ok: true }
        },
      },
    })

    const member = h.client(contract, { url, role: 'user' })
    const outsider = h.client(contract, { url, role: 'user' })

    const got = next<{ room: string; text: string; from: string }>((cb) => member.on('message', cb))
    let outsiderGot = false
    outsider.on('message', () => {
      outsiderGot = true
    })

    await member.join({ room: 'lobby' })
    await member.say({ room: 'lobby', text: 'hi' })

    expect(await got).toEqual({ room: 'lobby', text: 'hi', from: 'u1' })
    expect(outsiderGot).toBe(false)
  })

  it('stops delivering after remove and tracks size', async () => {
    const { srv, url } = await boot()
    let connRef: Conn | undefined
    srv.implement({
      user: {
        join: async ({ room }, _ctx, conn) => {
          connRef = conn
          srv.room(room).add(conn)
          return { ok: true }
        },
        say: async ({ room, text }, ctx) => {
          srv.room(room).broadcast('message', { room, text, from: ctx.id })
          return { ok: true }
        },
      },
    })

    const client = h.client(contract, { url, role: 'user' })
    let count = 0
    client.on('message', () => {
      count++
    })

    await client.join({ room: 'lobby' })
    expect(srv.room('lobby').size).toBe(1)

    srv.room('lobby').remove(connRef!)
    expect(srv.room('lobby').size).toBe(0)

    await client.say({ room: 'lobby', text: 'after-remove' })
    await new Promise((r) => setTimeout(r, 30))
    expect(count).toBe(0)
  })
})
