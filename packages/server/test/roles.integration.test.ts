import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness } from './harness.js'

// A user and an ai-agent connect to the same server with different surfaces.
const contract = defineContract({
  shared: {
    clientToServer: { whoami: { input: z.object({}), output: z.object({ role: z.string() }) } },
  },
  roles: {
    user: {
      clientToServer: {
        sendMessage: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
    agent: {
      clientToServer: {
        reportResult: { input: z.object({ taskId: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})

type Role = 'user' | 'agent'

const h = createHarness()
afterEach(() => h.dispose())

async function boot() {
  const { srv, url } = await h.server(contract, {
    // role + ctx come from the claimed role param, verified here
    authenticate: (req) => {
      const role = (new URL(req.url ?? '', 'http://localhost').searchParams.get('role') ?? 'user') as Role
      return role === 'agent'
        ? { role: 'agent' as const, ctx: { agentId: 'a1' } }
        : { role: 'user' as const, ctx: { userId: 'u1' } }
    },
  })
  srv.implement({
    shared: { whoami: async (_input, _ctx, conn) => ({ role: conn.role }) },
    user: {
      // ctx is narrowed to { userId: string } here
      sendMessage: async ({ text }, ctx) => ({ id: `${ctx.userId}:${text}` }),
    },
    agent: {
      // ctx is narrowed to { agentId: string } here
      reportResult: async ({ taskId }, ctx) => ({ ok: `${ctx.agentId}:${taskId}`.length > 0 }),
    },
  })
  return { srv, url }
}

describe('role-scoped contracts', () => {
  it('routes each role to its own surface with per-role ctx', async () => {
    const { url } = await boot()
    const user = h.client(contract, { url, role: 'user' })
    const agent = h.client(contract, { url, role: 'agent' })

    expect(await user.sendMessage({ text: 'hi' })).toEqual({ id: 'u1:hi' })
    expect(await agent.reportResult({ taskId: 't9' })).toEqual({ ok: true })
  })

  it('serves the shared surface to both roles, with conn.role available', async () => {
    const { url } = await boot()
    const user = h.client(contract, { url, role: 'user' })
    const agent = h.client(contract, { url, role: 'agent' })

    expect(await user.whoami({})).toEqual({ role: 'user' })
    expect(await agent.whoami({})).toEqual({ role: 'agent' })
  })

  it('rejects a cross-role call with NOT_FOUND (does not leak other roles)', async () => {
    const { url } = await boot()
    const user = h.client(contract, { url, role: 'user' })

    // a user hand-calling an agent-only method (bypassing the typed surface)
    const call = (user as unknown as { reportResult: (i: unknown) => Promise<unknown> }).reportResult({
      taskId: 't1',
    })
    await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
