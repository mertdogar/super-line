import { describe, expect, it } from 'vitest'
import { defineContract, type Adapter } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer } from '@super-line/server'
import { createHarness } from './harness.js'

/**
 * Shutdown has to reach the end. Both defects here had the same shape — an early failure abandoning
 * later steps — and the same symptom: a server the caller believes is gone, still holding a port and
 * its adapter subscriptions, quietly poisoning every later test in the file.
 */
const contract = defineContract({ roles: { user: {} } })
const auth = () => ({ role: 'user' as const, ctx: {} })

describe('teardown', () => {
  it('runs every harness cleanup even when one throws, and reports what failed', async () => {
    const h = createHarness()
    const bus = new MemoryBus()
    const a = await h.server(contract, { authenticate: auth, adapter: createInMemoryAdapter(bus) })
    const b = await h.server(contract, { authenticate: auth, adapter: createInMemoryAdapter(bus) })

    // A client close that throws sits in front of both servers in the cleanup order.
    const client = h.client(contract, { url: a.url, role: 'user' })
    client.close = () => {
      throw new Error('client close blew up')
    }

    await expect(h.dispose()).rejects.toThrow(/1 cleanup\(s\) failed/)

    // Both servers must still have been closed: close() is idempotent, so a second call resolving
    // proves nothing — instead check the ports are actually released.
    for (const srv of [a, b]) expect(srv.http.listening).toBe(false)
  })

  it('close() stops the transports even when the presence store throws', async () => {
    let stopped = false
    const broken: Adapter = {
      subscribe: () => {},
      unsubscribe: () => {},
      publish: () => {},
      onMessage: () => {},
      presence: {
        set: () => {},
        del: () => {},
        beat: () => {},
        clearNode: () => Promise.reject(new Error('broker went away')),
        addRoom: () => {},
        removeRoom: () => {},
        list: () => [],
        get: () => undefined,
        byUser: () => [],
        roomMembers: () => [],
        count: () => 0,
        topology: () => [],
      },
    }

    const srv = createSuperLineServer(contract, {
      authenticate: auth,
      adapter: broken,
      transports: [
        {
          start: () => {},
          stop: () => {
            stopped = true
          },
        },
      ],
    })

    await expect(srv.close()).resolves.toBeUndefined()
    expect(stopped).toBe(true)
  })
})
