import { afterEach, describe, expect, it } from 'vitest'
import { defineContract, type Schema } from '@super-line/core'
import { createSuperLineClient, type RowSetEvent } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { waitFor } from '../../core/test/wait.js'

// passthrough Standard Schema (client package has no zod dep) — validate returns the value unchanged
const s = (): Schema =>
  ({ '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } }) as unknown as Schema

const contract = defineContract({
  collections: { items: { schema: s(), key: 'id' } },
  roles: { user: {} },
})

const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

describe('client collection subscription', () => {
  it('keeps a later page: the snapshot applies offset, the client does not apply it again', async () => {
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loop.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      policies: { items: { read: () => undefined } },
    })
    closers.push(() => srv.close())
    for (const n of [1, 2, 3, 4, 5]) await srv.collection('items').insert({ id: `i${n}`, n })

    const client = createSuperLineClient(contract, { transport: loop.client(), role: 'user' })
    closers.unshift(() => client.close())
    const sub = client.collection('items').subscribe({ orderBy: [{ field: 'n', dir: 'asc' }], offset: 2, limit: 2 })
    await sub.ready
    expect(sub.rows().map((r) => (r as { id: string }).id)).toEqual(['i3', 'i4'])
  })

  it('streams only the limit window: an eviction is a delete, churn beyond the window is silent', async () => {
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loop.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      policies: { items: { read: () => undefined } },
    })
    closers.push(() => srv.close())
    for (const n of [1, 2, 3]) await srv.collection('items').insert({ id: `i${n}`, n })

    const client = createSuperLineClient(contract, { transport: loop.client(), role: 'user' })
    closers.unshift(() => client.close())
    const sub = client.collection('items').subscribe({ orderBy: [{ field: 'n', dir: 'asc' }], limit: 2 })
    await sub.ready
    const events: RowSetEvent[] = []
    sub.subscribe((ev) => events.push(ev))

    await srv.collection('items').insert({ id: 'i9', n: 9 }) // beyond the window
    await srv.collection('items').insert({ id: 'i0', n: 0 }) // pushes i2 out
    await waitFor(() => sub.rows().length > 0 && (sub.rows()[0] as { id: string }).id === 'i0')
    expect(sub.rows().map((r) => (r as { id: string }).id)).toEqual(['i0', 'i1'])
    expect(events).toEqual([
      { type: 'insert', id: 'i0', row: { id: 'i0', n: 0 } },
      { type: 'delete', id: 'i2' },
    ])
  })
})
