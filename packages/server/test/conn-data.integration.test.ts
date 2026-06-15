import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: {
      data: z.object({ count: z.number() }),
      clientToServer: { bump: { input: z.object({}), output: z.object({ count: z.number() }) } },
    },
  },
})

const auth = () => ({ role: 'user' as const, ctx: { userId: 'u1' } })
const identify = () => 'u1'
const describeConn = (conn: { data: unknown }) => ({ count: (conn.data as { count?: number }).count ?? 0 })

const h = createHarness()
afterEach(() => h.dispose())

describe('typed conn.data per role (slice 8)', () => {
  it('persists mutable per-connection state across requests', async () => {
    const { srv, url } = await h.server(contract, { authenticate: auth })
    srv.implement({
      user: {
        bump: async (_input, _ctx, conn) => {
          conn.data.count = (conn.data.count ?? 0) + 1
          return { count: conn.data.count }
        },
      },
    })

    const client = h.client(contract, { url, role: 'user' })
    expect(await client.bump({})).toEqual({ count: 1 })
    expect(await client.bump({})).toEqual({ count: 2 })
  })

  it('surfaces conn.data seeded in onConnection through describeConn', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      identify,
      describeConn,
      onConnection: (conn) => {
        ;(conn.data as { count?: number }).count = 7 // seed before the descriptor snapshot
      },
    })
    srv.implement({ user: { bump: async (_i, _c, conn) => ({ count: conn.data.count ?? 0 }) } })

    h.client(contract, { url, role: 'user' })
    await waitFor(() => srv.local.connections.length === 1)

    const [d] = await srv.cluster.connections()
    expect(d?.count).toBe(7)
  })
})
