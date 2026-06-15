import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { ValidationErrorInfo } from '@super-line/client'
import { createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        getNum: { input: z.object({}), output: z.object({ n: z.number() }) },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
      },
    },
  },
})

const h = createHarness()
afterEach(() => h.dispose())

// server returns a value that violates the output schema (server doesn't validate output)
const bad = { n: 'not-a-number' } as unknown as { n: number }

describe('client opt-in inbound validation', () => {
  it('rejects a response that violates the output schema when validate:inbound', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    srv.implement({ user: { getNum: async () => bad } })

    const client = h.client(contract, { url, role: 'user', validate: 'inbound' })
    await expect(client.getNum({})).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('passes drift through by default (validation is opt-in)', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    srv.implement({ user: { getNum: async () => bad } })

    const client = h.client(contract, { url, role: 'user' }) // default validate: 'off'
    expect(await client.getNum({})).toEqual({ n: 'not-a-number' })
  })

  it('drops a drifting topic message and reports via onValidationError', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    srv.implement({ user: { getNum: async () => ({ n: 1 }) } })

    const reported: ValidationErrorInfo[] = []
    const client = h.client(contract, {
      url,
      role: 'user',
      validate: 'inbound',
      onValidationError: (_e, info) => reported.push(info),
    })

    const received: Array<{ n: number }> = []
    await client.subscribe('feed', (p) => received.push(p)).ready

    srv.forRole('user').publish('feed', { n: 5 } as unknown as { n: number }) // ok
    srv.forRole('user').publish('feed', { n: 'bad' } as unknown as { n: number }) // drift
    await waitFor(() => reported.length === 1)
    await tick(20)

    expect(received).toEqual([{ n: 5 }]) // good delivered, drift dropped
    expect(reported).toEqual([{ kind: 'topic', name: 'feed' }])
  })
})
