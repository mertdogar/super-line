import { afterEach, describe, expect, it } from 'vitest'
import { defineContract } from '@super-line/core'
import { createSuperLineClient, type ClientPluginContext } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import * as z from 'zod'
import { waitFor } from '../../core/test/wait.js'

const contract = defineContract({
  collections: {
    notes: { schema: z.object({ id: z.string(), body: z.string(), done: z.boolean() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } },
  },
  shared: {
    clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    serverToClient: { room: { payload: z.object({ n: z.number() }), subscribe: true } },
  },
  roles: { user: {} },
})

const teardown: Array<() => unknown> = []
afterEach(async () => {
  for (const t of teardown.splice(0).reverse()) await t()
})

/** A client whose plugin captures the context, so a test can interrogate the live client. */
function setup() {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    collections: memoryCollections(),
    crdtCollections: crdtMemoryCollections(),
    policies: {
      notes: { read: () => undefined, write: () => true },
      scenes: { read: () => true, write: () => true },
    },
  })
  srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })

  let ctx!: ClientPluginContext
  let disposed = 0
  const cl = createSuperLineClient(contract, {
    transport: loop.client(),
    role: 'user',
    crdtCollections: crdtCollectionsClient(),
    plugins: [
      {
        name: 'probe',
        setup: (c) => {
          ctx = c
          return () => void disposed++
        },
      },
    ],
  })
  teardown.push(() => cl.close(), () => srv.close())
  return { srv, cl, ctx: () => ctx, disposed: () => disposed }
}

describe('ClientPluginContext (ADR-0024)', () => {
  it('runs setup once at construction and gives a stable, distinct clientId per instance', () => {
    const a = setup()
    const b = setup()
    expect(a.ctx().clientId).toBeTruthy()
    expect(a.ctx().role).toBe('user')
    expect(a.ctx().clientId).not.toBe(b.ctx().clientId) // a page runs several clients at once
  })

  it('calls the dispose returned by setup on client.close()', () => {
    const { cl, disposed } = setup()
    expect(disposed()).toBe(0)
    cl.close()
    expect(disposed()).toBe(1)
  })

  it('reports an in-flight request, then drops it once answered', async () => {
    const { cl, ctx } = setup()
    await cl.hello({}) // connect first, so the next call actually goes out
    const inflight = cl.hello({})
    const pending = ctx().getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ method: 'hello', sent: true })
    await inflight
    expect(ctx().getPending()).toHaveLength(0)
  })

  it('reports topic subscriptions with listener counts and ack state', async () => {
    const { cl, ctx } = setup()
    const sub = cl.subscribe('room', () => {})
    await sub.ready
    const topics = ctx().getTopics()
    expect(topics).toHaveLength(1)
    expect(topics[0]!).toMatchObject({ topic: 'room', listeners: 1, ready: true })

    const second = cl.subscribe('room', () => {})
    expect(ctx().getTopics()[0]!.listeners).toBe(2)
    second.unsubscribe()
    sub.unsubscribe()
    expect(ctx().getTopics()).toHaveLength(0)
  })

  it('exposes the rows a collection subscription is actually holding, not a reconstruction', async () => {
    const { srv, cl, ctx } = setup()
    await srv.collection('notes').insert({ id: 'n1', body: 'first', done: false })
    const sub = cl.collection('notes').subscribe({})
    await sub.ready

    const subs = ctx().getCollectionSubs()
    expect(subs).toHaveLength(1)
    expect(subs[0]!).toMatchObject({ n: 'notes', settled: true })
    expect(subs[0]!.rows).toEqual([{ id: 'n1', body: 'first', done: false }])

    await srv.collection('notes').insert({ id: 'n2', body: 'second', done: true })
    await waitFor(() => ctx().getCollectionSubs()[0]!.rows.length === 2)
  })

  it('reports open CRDT documents and their plaintext snapshot — unreachable from the wire', async () => {
    const { srv, cl, ctx } = setup()
    await srv.collection('scenes').create('s1', { title: 'hello' })
    const doc = cl.collection('scenes').open('s1')
    await waitFor(() => (doc.getSnapshot() as { title?: string })?.title === 'hello')

    const docs = ctx().getOpenDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ n: 'scenes', id: 's1', replicas: 1, deleted: false })

    // the wire carries only opaque base64 deltas; this is the only way to see contents
    expect(ctx().getDocSnapshot('scenes', 's1')).toMatchObject({ title: 'hello' })
    expect(ctx().getDocSnapshot('scenes', 'nope')).toBeUndefined()
  })
})
