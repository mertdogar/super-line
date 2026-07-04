import type { ServerStore, StoreInfo } from '@super-line/core'
import { defineContract } from '@super-line/core'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { inspector as inspectorPlugin } from '@super-line/plugin-inspector'
import { connectInspector, createHarness, waitFor } from './harness.js'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })

describe('store inspector events', () => {
  const h = createHarness()
  afterEach(() => h.dispose())

  it('emits store.subscribe / store.write / store.grant, with payload redaction', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: (hs) => ({ role: 'user' as const, ctx: { uid: hs.query.uid } }),
      identify: (conn) => (conn.ctx as { uid?: string }).uid,
      plugins: [inspectorPlugin({ redact: ['secret'] })],
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

describe('store inspection RPCs', () => {
  const h = createHarness()
  afterEach(() => h.dispose())

  it('lists stores with their model, lists resources, and reads materialized values', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      stores: { docs: memoryStoreServer() },
    })
    await srv.store('docs').create('d1', { v: 1, secret: 's' }, { ada: { read: false, write: false } })

    const inspector = await connectInspector(url)

    const stores = (await inspector.request('listStores')) as StoreInfo[]
    expect(stores).toEqual([{ name: 'docs', model: 'lww' }])

    const ids = (await inspector.request('listResources', { store: 'docs' })) as string[]
    expect(ids).toEqual(['d1'])

    // ACL bypass: ada has no read perms, yet the inspector reads the value + the access rules.
    const view = (await inspector.request('readResource', { store: 'docs', id: 'd1' })) as {
      data: { v: number }
      accessRules: Record<string, unknown>
    }
    expect(view.data).toEqual({ v: 1, secret: 's' })
    expect(view.accessRules).toEqual({ ada: { read: false, write: false } })

    inspector.close()
  })

  it('readResource materializes via open().getSnapshot(), not the opaque read().data', async () => {
    // A store whose read() is opaque (like the CRDT backend's base64 state) but open() materializes.
    const fake: ServerStore = {
      clustering: 'relay',
      model: 'crdt',
      read: () => ({ id: 'x', accessRules: {}, data: 'OPAQUE_STATE' }),
      create: () => {},
      apply: () => {},
      setAccess: () => {},
      delete: () => {},
      list: () => ['x'],
      onChange: () => () => {},
      open: () => ({
        getSnapshot: () => ({ title: 'decoded' }),
        subscribe: () => () => {},
        set: () => {},
        update: () => {},
        delete: () => {},
        close: () => {},
      }),
    }
    const { url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      stores: { crdt: fake },
    })
    const inspector = await connectInspector(url)
    const view = (await inspector.request('readResource', { store: 'crdt', id: 'x' })) as { data: unknown }
    expect(view.data).toEqual({ title: 'decoded' })
    inspector.close()
  })

  it('emits store.create and store.delete lifecycle events', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      stores: { docs: memoryStoreServer() },
    })
    const inspector = await connectInspector(url)
    await inspector.subscribeEvents()

    await srv.store('docs').create('d1', { v: 0 }, {})
    await srv.store('docs').delete('d1')

    await waitFor(() => inspector.events.some((e) => e.type === 'store.create'))
    await waitFor(() => inspector.events.some((e) => e.type === 'store.delete'))
    const created = inspector.events.find((e) => e.type === 'store.create') as unknown as { store: string; id: string }
    expect(created).toMatchObject({ store: 'docs', id: 'd1' })

    inspector.close()
  })
})
