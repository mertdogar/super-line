import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
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

    const docs = (await inspector.request('queryCollection', { collection: 'scene' })) as Array<{ id: string; title?: string }>
    expect(docs).toEqual([{ id: 'board', title: 'hello' }]) // synthesized doc-row

    inspector.close()
  })
})
