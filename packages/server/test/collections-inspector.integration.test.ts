import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq, gte, ilike, and } from '@super-line/core'
import type { CollectionInfo } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { inspector as inspectorPlugin } from '@super-line/plugin-inspector'
import { connectInspector, createHarness } from './harness.js'

const chat = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string() }),
      key: 'id',
      references: { authorId: 'users' },
    },
  },
  roles: { user: { clientToServer: {} } },
})

describe('collection inspection RPCs', () => {
  const h = createHarness()
  afterEach(() => h.dispose())

  it('lists collections (name/key/references for the schema graph) and browses rows, bypassing policy', async () => {
    const { srv, url } = await h.server(chat, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      collections: memoryCollections(),
      // a restrictive read policy — the inspector must see through it (trusted observer)
      policies: { messages: { read: () => eq('channelId', 'nope'), write: () => true }, users: { read: () => undefined, write: () => true } },
    })
    await srv.collection('users').insert({ id: 'u1', name: 'Ada' })
    await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'u1', text: 'hi' })
    await srv.collection('messages').insert({ id: 'm2', channelId: 'random', authorId: 'u1', text: 'yo' })

    const inspector = await connectInspector(url)

    const cols = (await inspector.request('listCollections')) as CollectionInfo[]
    expect(cols.map((c) => c.name).sort()).toEqual(['messages', 'users'])
    const messages = cols.find((c) => c.name === 'messages')
    expect(messages?.key).toBe('id')
    expect(messages?.references).toEqual({ authorId: 'users' }) // the FK edge for the graph

    // queryCollection bypasses the read policy (which would hide everything) — operator browsing
    const generals = (await inspector.request('queryCollection', { collection: 'messages', filter: eq('channelId', 'general') })) as { id: string }[]
    expect(generals.map((r) => r.id)).toEqual(['m1'])
    const all = (await inspector.request('queryCollection', { collection: 'messages' })) as { id: string }[]
    expect(all.map((r) => r.id).sort()).toEqual(['m1', 'm2'])

    // Each row carries the inspector-only created/updated timestamps (the CC's columns); the underlying
    // schema fields are untouched. They are epoch ms and, on a freshly inserted row, equal.
    const m1 = (all as Array<Record<string, unknown>>).find((r) => r.id === 'm1')!
    expect(typeof m1._createdAt).toBe('number')
    expect(typeof m1._updatedAt).toBe('number')
    expect(m1._createdAt).toBe(m1._updatedAt)
    expect(m1).toMatchObject({ id: 'm1', channelId: 'general', authorId: 'u1', text: 'hi' })

    await expect(inspector.request('queryCollection', { collection: 'ghost' })).rejects.toThrow()

    inspector.close()
  })

  it('surfaces CRDT document collections: listed + browsable as { id, ...snapshot } rows', async () => {
    const canvas = defineContract({
      collections: { scene: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } } },
      roles: { user: { clientToServer: {} } },
    })
    const { srv, url } = await h.server(canvas, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      crdtCollections: crdtMemoryCollections(),
      policies: { scene: { read: () => true, write: () => true } },
    })
    await srv.collection('scene').create('board', { title: 'hello' })

    const inspector = await connectInspector(url)
    const cols = (await inspector.request('listCollections')) as CollectionInfo[]
    expect(cols.map((c) => c.name)).toContain('scene') // CRDT collection now visible in the CC
    expect(cols.find((c) => c.name === 'scene')?.key).toBe('id')

    const docs = (await inspector.request('queryCollection', { collection: 'scene' })) as Array<Record<string, unknown>>
    expect(docs[0]).toMatchObject({ id: 'board', title: 'hello' }) // synthesized doc-row
    // CRDT collections carry created/updated too — merged from each DocSummary (free; already tracked per-doc).
    expect(typeof docs[0]!._createdAt).toBe('number')
    expect(typeof docs[0]!._updatedAt).toBe('number')

    inspector.close()
  })
})

describe('collection inspection — filter & sort', () => {
  const h = createHarness()
  afterEach(() => h.dispose())
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const shop = defineContract({
    collections: {
      products: { schema: z.object({ id: z.string(), name: z.string(), price: z.number(), inStock: z.boolean() }), key: 'id' },
    },
    roles: { user: { clientToServer: {} } },
  })

  it('pushes a structured filter to the whole collection and reports crdt: false', async () => {
    const { srv, url } = await h.server(shop, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      collections: memoryCollections(),
      policies: { products: { read: () => eq('id', 'nope'), write: () => true } }, // restrictive — inspector sees through
    })
    await srv.collection('products').insert({ id: 'a', name: 'Apple', price: 3, inStock: true })
    await srv.collection('products').insert({ id: 'b', name: 'Banana', price: 1, inStock: false })
    await srv.collection('products').insert({ id: 'c', name: 'Cherry', price: 5, inStock: true })

    const inspector = await connectInspector(url)
    const cols = (await inspector.request('listCollections')) as CollectionInfo[]
    expect(cols.find((c) => c.name === 'products')?.crdt).toBe(false)

    // price >= 3 AND inStock === true → a (3) and c (5), not b
    const filtered = (await inspector.request('queryCollection', { collection: 'products', filter: and(gte('price', 3), eq('inStock', true)) })) as { id: string }[]
    expect(filtered.map((r) => r.id).sort()).toEqual(['a', 'c'])
    inspector.close()
  })

  it('sorts rows by the inspector-only created/updated timestamps, honoring limit/offset', async () => {
    const { srv, url } = await h.server(shop, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      collections: memoryCollections(),
      policies: { products: { read: () => undefined, write: () => true } },
    })
    await srv.collection('products').insert({ id: 'a', name: 'A', price: 1, inStock: true })
    await sleep(5)
    await srv.collection('products').insert({ id: 'b', name: 'B', price: 2, inStock: true })
    await sleep(5)
    await srv.collection('products').insert({ id: 'c', name: 'C', price: 3, inStock: true })
    await sleep(5)
    await srv.collection('products').update({ id: 'a', name: 'A2', price: 1, inStock: true }) // bump a's updatedAt to newest

    const inspector = await connectInspector(url)
    const byCreatedDesc = (await inspector.request('queryCollection', { collection: 'products', orderBy: [{ field: '_createdAt', dir: 'desc' }] })) as { id: string }[]
    expect(byCreatedDesc.map((r) => r.id)).toEqual(['c', 'b', 'a']) // newest-created first

    // paging through the timestamp-sorted scan
    const page1 = (await inspector.request('queryCollection', { collection: 'products', orderBy: [{ field: '_createdAt', dir: 'asc' }], limit: 2, offset: 0 })) as { id: string }[]
    expect(page1.map((r) => r.id)).toEqual(['a', 'b'])
    const page2 = (await inspector.request('queryCollection', { collection: 'products', orderBy: [{ field: '_createdAt', dir: 'asc' }], limit: 2, offset: 2 })) as { id: string }[]
    expect(page2.map((r) => r.id)).toEqual(['c'])

    const byUpdatedDesc = (await inspector.request('queryCollection', { collection: 'products', orderBy: [{ field: '_updatedAt', dir: 'desc' }] })) as { id: string }[]
    expect(byUpdatedDesc[0]?.id).toBe('a') // a was updated last
    inspector.close()
  })

  it('filters CRDT docs by id substring and sorts by created', async () => {
    const canvas = defineContract({
      collections: { scene: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } } },
      roles: { user: { clientToServer: {} } },
    })
    const { srv, url } = await h.server(canvas, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      crdtCollections: crdtMemoryCollections(),
      policies: { scene: { read: () => true, write: () => true } },
    })
    await srv.collection('scene').create('apple', { title: 'a' })
    await sleep(5)
    await srv.collection('scene').create('banana', { title: 'b' })
    await sleep(5)
    await srv.collection('scene').create('cherry', { title: 'c' })

    const inspector = await connectInspector(url)
    expect(((await inspector.request('listCollections')) as CollectionInfo[]).find((c) => c.name === 'scene')?.crdt).toBe(true)

    const an = (await inspector.request('queryCollection', { collection: 'scene', filter: ilike('id', '%an%') })) as { id: string }[]
    expect(an.map((r) => r.id)).toEqual(['banana']) // only 'banana' contains 'an'

    const byCreatedDesc = (await inspector.request('queryCollection', { collection: 'scene', orderBy: [{ field: '_createdAt', dir: 'desc' }] })) as { id: string }[]
    expect(byCreatedDesc.map((r) => r.id)).toEqual(['cherry', 'banana', 'apple'])
    inspector.close()
  })
})
