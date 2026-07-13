import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { inspector } from '@super-line/plugin-inspector'
import { connectInspector, createHarness, waitFor } from './harness.js'

// A contract with both an LWW row collection (`notes`) and a CRDT document collection (`scenes`), so one
// server exercises the whole collection + CRDT inspector-event surface added for the Control Center feed.
const contract = defineContract({
  collections: {
    notes: { schema: z.object({ id: z.string(), text: z.string(), secret: z.string() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().optional(), count: z.number().optional() }), crdt: { mode: 'document' } },
  },
  roles: { user: { clientToServer: {} } },
})

const authenticate = (h: { query: Record<string, string> }) => ({ role: 'user' as const, ctx: { uid: h.query.uid ?? 'anon' } })

const h = createHarness()
afterEach(() => h.dispose())

function serve(write = true) {
  return h.server(contract, {
    authenticate,
    identify: (conn) => (conn.ctx as { uid: string }).uid,
    collections: memoryCollections(),
    crdtCollections: crdtMemoryCollections(),
    plugins: [inspector({ redact: ['secret'] })],
    policies: {
      notes: { read: () => undefined, write: () => write },
      scenes: { read: () => true, write: () => write },
    },
  })
}

describe('collection inspector events (feed)', () => {
  it('mirrors collection.sub / write / change with outcomes and redacts row payloads', async () => {
    const { url } = await serve()
    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const client = h.client(contract, { url, role: 'user', params: { uid: 'ada' } })
    const sub = client.collection('notes').subscribe({ filter: eq('id', 'n1') })
    await sub.ready
    await client.collection('notes').insert({ id: 'n1', text: 'hello', secret: 's3cr3t' })

    await waitFor(() => insp.events.some((e) => e.type === 'collection.sub'))
    await waitFor(() => insp.events.some((e) => e.type === 'collection.write' && e.ok === true))
    await waitFor(() => insp.events.some((e) => e.type === 'collection.change'))

    const subEv = insp.events.find((e) => e.type === 'collection.sub')!
    expect(subEv.n).toBe('notes')
    expect(subEv.ok).toBe(true)

    const writeEv = insp.events.find((e) => e.type === 'collection.write')!
    const ops = writeEv.ops as Array<{ op: string; d: { text: string; secret: string } }>
    expect(ops[0]?.op).toBe('insert')
    expect(ops[0]?.d.text).toBe('hello')
    expect(ops[0]?.d.secret).toBe('[Redacted]') // redacted by field name before crossing the bus

    const chg = insp.events.find((e) => e.type === 'collection.change')!
    expect(chg.n).toBe('notes')
    expect(chg.op).toBe('insert')
    expect(chg.id).toBe('n1')
    expect((chg.row as { secret: string }).secret).toBe('[Redacted]')

    insp.close()
  })

  it('emits collection.write ok:false when a write is denied', async () => {
    const { url } = await serve(false)
    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const client = h.client(contract, { url, role: 'user', params: { uid: 'ada' } })
    await client.collection('notes').insert({ id: 'n2', text: 'x', secret: 'y' }).catch(() => {})

    await waitFor(() => insp.events.some((e) => e.type === 'collection.write' && e.ok === false))
    const ev = insp.events.find((e) => e.type === 'collection.write' && e.ok === false)!
    expect(ev.error?.code).toBe('FORBIDDEN')
    // the denied op did NOT commit, so no collection.change was fanned
    expect(insp.events.some((e) => e.type === 'collection.change')).toBe(false)
    insp.close()
  })
})

describe('CRDT document inspector events (feed)', () => {
  it('mirrors crdt.open / write / change and surfaces the post-merge snapshot', async () => {
    const { srv, url } = await serve()
    await srv.collection('scenes').create('s1', { title: 'hello' })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const client = h.client(contract, { url, role: 'user', params: { uid: 'ada' }, crdtCollections: crdtCollectionsClient() })
    const doc = client.collection('scenes').open('s1')
    await doc.ready
    doc.update({ title: 'world' })

    await waitFor(() => insp.events.some((e) => e.type === 'crdt.open'))
    await waitFor(() => insp.events.some((e) => e.type === 'crdt.write' && e.ok === true))
    await waitFor(() => insp.events.some((e) => e.type === 'crdt.change'))

    const openEv = insp.events.find((e) => e.type === 'crdt.open')!
    expect(openEv.n).toBe('scenes')
    expect(openEv.id).toBe('s1')
    expect((openEv.snapshot as { title: string }).title).toBe('hello') // catch-up snapshot the server already had

    const writeEv = insp.events.find((e) => e.type === 'crdt.write' && e.ok === true)!
    expect(writeEv.deltaBytes).toBeGreaterThan(0) // opaque delta size (the delta itself is never surfaced)
    expect((writeEv.snapshot as { title: string }).title).toBe('world') // post-merge plaintext, not the opaque delta

    const chg = insp.events.find((e) => e.type === 'crdt.change')!
    expect(chg.n).toBe('scenes')
    expect(chg.id).toBe('s1')
    expect(chg.deltaBytes).toBeGreaterThan(0)
    insp.close()
  })

  it('emits crdt.write ok:false when a write is denied', async () => {
    const { srv, url } = await serve(false)
    await srv.collection('scenes').create('s2', { title: 'seed' })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const client = h.client(contract, { url, role: 'user', params: { uid: 'ada' }, crdtCollections: crdtCollectionsClient(), onStoreError: () => {} })
    const doc = client.collection('scenes').open('s2')
    await doc.ready
    doc.update({ title: 'nope' })

    await waitFor(() => insp.events.some((e) => e.type === 'crdt.write' && e.ok === false))
    const ev = insp.events.find((e) => e.type === 'crdt.write' && e.ok === false)!
    expect(ev.error?.code).toBe('FORBIDDEN')
    // a denied write never commits, so no crdt.change fan-out
    expect(insp.events.some((e) => e.type === 'crdt.change')).toBe(false)
    insp.close()
  })
})
