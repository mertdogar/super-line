import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { crdtMemoryCollections, crdtCollectionsClient, yDocOf } from '@super-line/collections-crdt-memory'
import * as z from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from '../../core/test/wait.js'

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

// A native root — a CRDT type bound beside the described root — is how content whose merge granularity is
// finer than a field (collaborative text) rides a CRDT document collection. Two things have to be true for it
// to work end to end, and neither was before: edits made straight to the engine's document must reach the
// wire at all (nothing calls `set`, so there is no return value to carry them), and the schema gate must be
// skippable, because folding the whole document to validate it cannot run per keystroke.
describe('CRDT document collections — native roots over the wire', () => {
  const proseContract = defineContract({
    collections: {
      prose: { schema: z.object({}), crdt: { mode: 'document', validate: false } },
    },
    roles: { user: { clientToServer: {} } },
  })

  function setupProse() {
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(proseContract, {
      transports: [loop.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      crdtCollections: crdtMemoryCollections(),
      policies: { prose: { read: () => true, write: () => true } },
    })
    const clients: Array<SuperLineClient<typeof proseContract, 'user'>> = []
    const makeClient = (): SuperLineClient<typeof proseContract, 'user'> => {
      const cl = createSuperLineClient(proseContract, {
        transport: loop.client(),
        role: 'user',
        crdtCollections: crdtCollectionsClient(),
      })
      clients.push(cl)
      return cl
    }
    return { srv, makeClient, close: () => clients.forEach((c) => c.close()) }
  }

  it('writes a native-root edit through to every peer, and merges concurrent ones', async () => {
    const env = setupProse()
    try {
      await env.srv.collection('prose').create('doc', {})
      const a = env.makeClient().collection('prose').open('doc')
      const b = env.makeClient().collection('prose').open('doc')
      await Promise.all([a.ready, b.ready])

      // No `set` call anywhere: mutate the engine's document directly, exactly as an editor binding does.
      const ta = yDocOf(a).getText('body')
      const tb = yDocOf(b).getText('body')
      ta.insert(0, 'hello')
      await waitFor(() => tb.toString() === 'hello')

      // Concurrent inserts at the same position merge instead of one overwriting the other — the property a
      // plain string field cannot have, since the described root replaces its value whole on every write.
      ta.insert(5, '-A')
      tb.insert(5, '-B')
      await waitFor(() => ta.toString().length === 9 && tb.toString().length === 9)
      expect(ta.toString()).toBe(tb.toString()) // converged
      expect(ta.toString()).toContain('-A')
      expect(ta.toString()).toContain('-B')

      // ...and none of it is in the described snapshot, so nothing downstream of it ever saw the text.
      expect(await env.srv.collection('prose').read('doc')).toEqual({})
    } finally {
      env.close()
    }
  })

  it('commits without the schema gate when the collection declares validate: false', async () => {
    const env = setupProse()
    try {
      await env.srv.collection('prose').create('doc', {})
      const doc = env.makeClient().collection('prose').open('doc')
      const other = env.makeClient().collection('prose').open('doc')
      await Promise.all([doc.ready, other.ready])

      // `prose` is declared `z.object({})`; a described-root write that a validated collection would reject
      // commits here, because no validator is passed and so the fold never runs. Asserting on the OTHER
      // client is what proves the server accepted it — a rejected delta is never fanned out, and its writer
      // is resynced back. That IS the trade: the policy still decides who may write, nothing decides what.
      doc.set({ anything: 'goes' } as never)
      await waitFor(() => (other.getSnapshot() as { anything?: string } | undefined)?.anything === 'goes')
      expect(await env.srv.collection('prose').read('doc')).toEqual({ anything: 'goes' })
    } finally {
      env.close()
    }
  })
})
