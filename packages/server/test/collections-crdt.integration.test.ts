import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'

const contract = defineContract({
  collections: {
    scenes: {
      schema: z.object({ title: z.string().optional(), count: z.number().optional() }),
      crdt: { mode: 'document' },
    },
  },
  roles: { user: { clientToServer: {} } },
})
type Client = SuperLineClient<typeof contract, 'user'>
type Scene = { title?: string; count?: number }

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup(policyOverride?: { read?: boolean; write?: boolean }) {
  const loop = createLoopbackTransport()
  const errors: Array<{ store: string; id: string }> = []
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    crdtCollections: crdtMemoryCollections(),
    policies: {
      scenes: {
        read: () => policyOverride?.read ?? true,
        write: () => policyOverride?.write ?? true,
      },
    },
  })
  const clients: Client[] = []
  const makeClient = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      crdtCollections: crdtCollectionsClient(),
      onStoreError: (_e, info) => errors.push(info),
    })
    clients.push(cl)
    return cl
  }
  return { srv, makeClient, clients, errors }
}

describe('CRDT document collections (ADR-0007)', () => {
  let env: ReturnType<typeof setup>
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('server-authoritative create → client opens and catches up', async () => {
    env = setup()
    await env.srv.collection('scenes').create('s1', { title: 'hello' })
    const doc = env.makeClient('alice').collection('scenes').open('s1')
    await doc.ready
    expect(doc.getSnapshot()).toMatchObject({ title: 'hello' })
  })

  it('opening a non-existent document rejects (NOT_FOUND) — creation is server-only', async () => {
    env = setup()
    const doc = env.makeClient('alice').collection('scenes').open('nope')
    await expect(doc.ready).rejects.toThrow(/No document|NOT_FOUND/)
  })

  it('a client write merges and syncs to another client', async () => {
    env = setup()
    await env.srv.collection('scenes').create('s1', { title: 'a' })
    const a = env.makeClient('alice').collection('scenes').open('s1')
    const b = env.makeClient('bob').collection('scenes').open('s1')
    await Promise.all([a.ready, b.ready])
    a.update({ title: 'world' })
    await waitFor(() => (b.getSnapshot() as Scene)?.title === 'world')
    expect((b.getSnapshot() as Scene).title).toBe('world')
  })

  it('per-open origin tags one handle`s writes; a sibling handle on the SAME connection converges via the echo', async () => {
    env = setup()
    await env.srv.collection('scenes').create('s1', { title: 'a' })
    const client = env.makeClient('alice')
    const tagged = client.collection('scenes').open('s1', { origin: 'agent:planner' })
    const plain = client.collection('scenes').open('s1')
    await Promise.all([tagged.ready, plain.ready])
    tagged.update({ title: 'tagged write' })
    // distinct origins ⇒ the plain handle must NOT echo-break the tagged handle's change
    await waitFor(() => (plain.getSnapshot() as Scene).title === 'tagged write')
  })

  it('concurrent edits to different fields converge (CRDT merge, not LWW clobber)', async () => {
    env = setup()
    await env.srv.collection('scenes').create('s1', {})
    const a = env.makeClient('alice').collection('scenes').open('s1')
    const b = env.makeClient('bob').collection('scenes').open('s1')
    await Promise.all([a.ready, b.ready])
    a.update({ title: 'x' })
    b.update({ count: 5 })
    await waitFor(() => {
      const sa = a.getSnapshot() as Scene
      const sb = b.getSnapshot() as Scene
      return sa?.title === 'x' && sa?.count === 5 && sb?.title === 'x' && sb?.count === 5
    })
    expect(a.getSnapshot()).toMatchObject({ title: 'x', count: 5 })
  })

  it('validate-before-commit: a write that would break the schema is rejected server-side (others never see it)', async () => {
    env = setup()
    await env.srv.collection('scenes').create('s1', { title: 'ok' })
    const a = env.makeClient('alice').collection('scenes').open('s1')
    const b = env.makeClient('bob').collection('scenes').open('s1')
    await Promise.all([a.ready, b.ready])
    a.set({ title: 42 } as unknown as Scene) // title must be a string → server rejects the delta
    await waitFor(() => env.errors.length > 0)
    expect(env.errors[0]).toMatchObject({ store: 'scenes', id: 's1' })
    // canonical stayed valid: the server co-writer and the other client never saw the bad value
    expect(await env.srv.collection('scenes').read('s1')).toMatchObject({ title: 'ok' })
    expect((b.getSnapshot() as Scene).title).toBe('ok')
    // reject→resync: the writer's own optimistic edit is discarded — its replica returns to authoritative
    await waitFor(() => (a.getSnapshot() as Scene).title === 'ok')
    expect(a.getSnapshot()).toMatchObject({ title: 'ok' })
  })

  it('read policy denies open (deny-by-default guard)', async () => {
    env = setup({ read: false })
    await env.srv.collection('scenes').create('s1', { title: 'secret' })
    const doc = env.makeClient('mallory').collection('scenes').open('s1')
    await expect(doc.ready).rejects.toThrow(/denied|FORBIDDEN/)
  })
})
