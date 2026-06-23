import { defineContract } from '@super-line/core'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { connectInspector, createHarness, waitFor } from './harness.js'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })

describe('store inspector events', () => {
  const h = createHarness()
  afterEach(() => h.dispose())

  it('emits store.subscribe / store.write / store.grant, with payload redaction', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: (hs) => ({ role: 'user' as const, ctx: { uid: hs.query.uid } }),
      identify: (conn) => (conn.ctx as { uid?: string }).uid,
      inspector: { redact: ['secret'] },
      stores: { docs: memoryStoreServer() },
    })
    await srv.store('docs').create('d1', { v: 0 }, { ada: { read: true, write: true } })

    const inspector = await connectInspector(url)
    await inspector.subscribeEvents()

    const client = h.client(contract, {
      url,
      role: 'user',
      params: { uid: 'ada' },
      stores: { docs: memoryStoreClient() },
    })
    const handle = client.store('docs').open('d1')
    await handle.ready
    handle.set({ v: 1, secret: 'shh' })
    await srv.store('docs').grant('d1', 'bob', { read: true, write: false })

    await waitFor(() => inspector.events.some((e) => e.type === 'store.write'))
    await waitFor(() => inspector.events.some((e) => e.type === 'store.grant'))

    expect(inspector.events.some((e) => e.type === 'store.subscribe')).toBe(true)

    const write = inspector.events.find((e) => e.type === 'store.write')
    const data = write?.data as { v: number; secret: string }
    expect(data.v).toBe(1)
    expect(data.secret).toBe('[Redacted]') // field-redacted before crossing the bus

    inspector.close()
  })
})
