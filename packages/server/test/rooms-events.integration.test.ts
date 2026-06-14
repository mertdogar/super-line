import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { Conn } from '@super-line/server'
import { createHarness } from './harness.js'

const contract = defineContract({
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    say: {
      input: z.object({ room: z.string(), text: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {
    message: z.object({ room: z.string(), text: z.string(), from: z.string() }),
  },
  topics: {},
})

const h = createHarness()
afterEach(() => h.dispose())

function next<T>(register: (cb: (data: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => register(resolve))
}

describe('rooms + events', () => {
  it('broadcasts a contract event to room members and not to outsiders', async () => {
    const { srv, url } = await h.server(contract, { authenticate: () => ({ id: 'u1' }) })
    srv.implement({
      join: async ({ room }, _ctx, conn: Conn<{ id: string }>) => {
        srv.room(room).add(conn)
        return { ok: true }
      },
      say: async ({ room, text }, ctx) => {
        srv.room(room).broadcast('message', { room, text, from: ctx.id })
        return { ok: true }
      },
    })

    const member = h.client(contract, { url })
    const outsider = h.client(contract, { url })

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
    let connRef: Conn<{ id: string }> | undefined
    const { srv, url } = await h.server(contract, { authenticate: () => ({ id: 'u1' }) })
    srv.implement({
      join: async ({ room }, _ctx, conn: Conn<{ id: string }>) => {
        connRef = conn
        srv.room(room).add(conn)
        return { ok: true }
      },
      say: async ({ room, text }, ctx) => {
        srv.room(room).broadcast('message', { room, text, from: ctx.id })
        return { ok: true }
      },
    })

    const client = h.client(contract, { url })
    let count = 0
    client.on('message', () => {
      count++
    })

    await client.join({ room: 'lobby' })
    expect(srv.room('lobby').size).toBe(1)

    srv.room('lobby').remove(connRef!)
    expect(srv.room('lobby').size).toBe(0)

    await client.say({ room: 'lobby', text: 'after-remove' })
    // give any erroneous broadcast a tick to arrive
    await new Promise((r) => setTimeout(r, 30))
    expect(count).toBe(0)
  })
})
