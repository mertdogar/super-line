import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import type { ClientErrorInfo } from '@super-line/client'
import type { Conn } from '@super-line/server'
import { createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        hang: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
      },
    },
  },
})

const tasksContract = defineContract({
  collections: {
    tasks: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
  },
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
})

const h = createHarness()
afterEach(() => h.dispose())

describe('client reconnect', () => {
  it('auto-reconnects and re-subscribes topics after an abrupt drop', async () => {
    let lastConn: Conn | undefined
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (c) => {
        lastConn = c
      },
    })
    srv.implement({ user: { hang: () => new Promise<never>(() => {}) } })

    const client = h.client(contract, { url, role: 'user', reconnectBaseMs: 10, reconnectMaxMs: 50 })
    const received: Array<{ symbol: string; price: number }> = []
    await client.subscribe('prices', (p) => received.push(p)).ready

    srv.forRole('user').publish('prices', { symbol: 'A', price: 1 })
    await waitFor(() => received.length === 1)

    const firstConn = lastConn
    firstConn!.terminate() // simulate a network drop

    await waitFor(() => lastConn !== firstConn && client.connected, 3000)

    srv.forRole('user').publish('prices', { symbol: 'B', price: 2 })
    await waitFor(() => received.length === 2, 3000)
    expect(received[1]).toEqual({ symbol: 'B', price: 2 })
  })

  it('rejects in-flight requests with DISCONNECTED when the connection drops', async () => {
    let lastConn: Conn | undefined
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (c) => {
        lastConn = c
      },
    })
    srv.implement({ user: { hang: () => new Promise<never>(() => {}) } })

    const client = h.client(contract, { url, role: 'user', reconnectBaseMs: 10 })
    await waitFor(() => client.connected)

    const inflight = client.hang({})
    await tick(20) // ensure the request was sent
    lastConn!.terminate()

    await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  // The topic case above is mirrored here for row collections: it is the property an out-of-process client
  // (an agent whose only inputs arrive over a subscription) bets its correctness on.
  it('auto-re-subscribes a collection after an abrupt drop, delivering rows written during the outage', async () => {
    let lastConn: Conn | undefined
    const { srv, url } = await h.server<typeof tasksContract, { role: 'user'; ctx: Record<string, never> }>(tasksContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      identify: () => 'u1',
      collections: memoryCollections(),
      policies: { tasks: { read: () => undefined, write: () => true } },
      onConnection: (c) => {
        lastConn = c
      },
    })
    await srv.collection('tasks').insert({ id: 't1', text: 'before' })

    const client = h.client(tasksContract, { url, role: 'user', reconnectBaseMs: 10, reconnectMaxMs: 50 })
    const sub = client.collection('tasks').subscribe({})
    await sub.ready
    expect(sub.rows().map((r) => r.id)).toEqual(['t1'])

    const firstConn = lastConn
    firstConn!.terminate() // simulate a network drop
    await waitFor(() => !client.connected, 3000) // the write below must land while the client is away

    await srv.collection('tasks').insert({ id: 't2', text: 'during the outage' })

    await waitFor(() => lastConn !== firstConn && client.connected, 3000)
    await waitFor(() => sub.rows().length === 2, 3000)
    expect(sub.rows().map((r) => r.id).sort()).toEqual(['t1', 't2']) // the outage write arrives via the re-seed
  })

  it('surfaces a settled subscription’s re-subscribe failure on onError rather than going silently deaf', async () => {
    let lastConn: Conn | undefined
    let revoked = false
    const { url } = await h.server<typeof tasksContract, { role: 'user'; ctx: Record<string, never> }>(tasksContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      identify: () => 'u1',
      collections: memoryCollections(),
      policies: {
        // The read policy is re-evaluated on every (re)subscribe, so authorization lost during an outage
        // makes the re-`csub` throw — the reachable path this test pins.
        tasks: {
          read: () => {
            if (revoked) throw new SuperLineError('FORBIDDEN', 'access revoked during the outage')
            return undefined
          },
          write: () => true,
        },
      },
      onConnection: (c) => {
        lastConn = c
      },
    })

    const errors: Array<{ error: unknown; info: ClientErrorInfo }> = []
    const client = h.client(tasksContract, {
      url,
      role: 'user',
      reconnectBaseMs: 10,
      reconnectMaxMs: 50,
      onError: (error, info) => errors.push({ error, info }),
    })
    const sub = client.collection('tasks').subscribe({})
    await sub.ready // settled — `ready` can never reject again, so onError is the only channel left

    revoked = true
    const firstConn = lastConn
    firstConn!.terminate()
    await waitFor(() => lastConn !== firstConn && client.connected, 3000)

    await waitFor(() => errors.some((e) => e.info.kind === 'resubscribe'), 3000)
    const failure = errors.find((e) => e.info.kind === 'resubscribe')!
    expect(failure.info.collection).toBe('tasks')
    expect(failure.error).toMatchObject({ code: 'FORBIDDEN' })
    expect(client.connected).toBe(true) // the point: connected, but that subscription is dead
  })
})
