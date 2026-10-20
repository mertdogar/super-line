import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { defineContract, eq, type CollectionStore, type RowChange, type SelfCollectionStore } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { composeCollections, createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { runRowConformance } from '../../core/test/collection-store-conformance.js'
import { waitFor } from '../../core/test/wait.js'

// The suite's collections (messages, users) live on a non-default backend; anything else falls through to default.
runRowConformance('composeCollections', {
  make: () => {
    const named = memoryCollections()
    return composeCollections({ default: memoryCollections(), messages: named, users: named })
  },
  clustering: 'relay',
})

const note = (id: string) => ({ id, text: id })
const insert = (n: string, id: string) => ({ op: 'insert' as const, n, id, row: note(id) })

/** A `self` backend over a memory store: `feed.apply` stands in for its replication feed; its own apply is recorded. */
function fakeSelf() {
  const feed = memoryCollections()
  const apply = vi.fn(async () => {})
  const store: SelfCollectionStore = {
    ...feed,
    clustering: 'self',
    coordination: 'cluster',
    apply,
    conditionalApply: async () => true,
  }
  return { store, feed, apply }
}

describe('composeCollections', () => {
  it('routes snapshot, read, rowMeta and fixedFields by collection name, the rest to default', async () => {
    const a = memoryCollections()
    const b = { ...memoryCollections(), fixedFields: () => ['text'] }
    const s = composeCollections({ default: a, remote: b })
    await s.apply([insert('notes', 'n1')], 'o')
    await s.apply([insert('remote', 'r1')], 'o')

    expect(a.read('notes', 'n1')).toEqual(note('n1'))
    expect(a.read('remote', 'r1')).toBeUndefined()
    expect(b.read('remote', 'r1')).toEqual(note('r1'))
    expect(b.read('notes', 'n1')).toBeUndefined()
    expect(await s.snapshot('remote', {})).toEqual([note('r1')])
    expect(await s.read('notes', 'n1')).toEqual(note('n1'))
    expect(Object.keys(await s.rowMeta!('remote', ['r1', 'n1']))).toEqual(['r1'])
    expect(s.fixedFields!('remote')).toEqual(['text'])
    expect(s.fixedFields!('notes')).toEqual([])
  })

  it('fans onChange in from every backend once, and detaches from all of them', async () => {
    const a = memoryCollections()
    const b = memoryCollections()
    const s = composeCollections({ default: a, remote: b, other: b })
    const seen: RowChange[] = []
    const off = s.onChange((c) => seen.push(c))

    a.apply([insert('notes', 'n1')], 'o')
    b.apply([insert('remote', 'r1')], 'o')
    expect(seen.map((c) => c.id)).toEqual(['n1', 'r1'])

    off()
    b.apply([insert('remote', 'r2')], 'o')
    expect(seen).toHaveLength(2)
  })

  it('rejects a batch spanning two backends before applying any of it', async () => {
    const a = memoryCollections()
    const b = memoryCollections()
    const s = composeCollections({ default: a, remote: b, other: b })

    expect(() => s.apply([insert('notes', 'n1'), insert('remote', 'r1')], 'o')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    )
    expect(() =>
      s.conditionalApply([{ n: 'notes', id: 'n1', filter: eq('id', 'n1') }], [insert('remote', 'r1')], 'o'),
    ).toThrow(/spans collection backends/)
    expect(a.read('notes', 'n1')).toBeUndefined()
    expect(b.read('remote', 'r1')).toBeUndefined()

    await s.apply([insert('remote', 'r1'), insert('other', 'x1')], 'o') // two names, one backend: one batch
    expect(b.read('other', 'x1')).toEqual(note('x1'))
  })

  it('closes every backend once', async () => {
    const a = { ...memoryCollections(), close: vi.fn() }
    const b = { ...memoryCollections(), close: vi.fn(async () => {}) }
    await composeCollections({ default: a, remote: b, other: b }).close?.()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it('is self only when every backend is, delegating writes to the owner', async () => {
    const a = fakeSelf()
    const b = fakeSelf()
    const s = composeCollections({ default: a.store, remote: b.store })
    expect([s.clustering, s.coordination]).toEqual(['self', 'cluster'])

    await s.apply([insert('remote', 'r1')], 'o')
    expect(b.apply).toHaveBeenCalledWith([insert('remote', 'r1')], 'o')
    expect(a.apply).not.toHaveBeenCalled()
    expect(() => s.apply([insert('notes', 'n1'), insert('remote', 'r1')], 'o')).toThrow(/spans collection backends/)
  })

  it('is relay for a mix, with the self collections read-only through it', async () => {
    const self = fakeSelf()
    const s = composeCollections({ default: memoryCollections(), remote: self.store })
    expect([s.clustering, s.coordination]).toEqual(['relay', 'local'])

    expect(() => s.apply([insert('remote', 'r1')], 'o')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(self.apply).not.toHaveBeenCalled()

    const seen: RowChange[] = []
    s.onChange((c) => seen.push(c))
    self.feed.apply([insert('remote', 'r1')], 'source')
    expect(seen.map((c) => c.id)).toEqual(['r1'])
    expect(await s.snapshot('remote', {})).toEqual([note('r1')])
  })
})

const contract = defineContract({
  collections: {
    notes: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
    remote: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
  },
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function boot(collections: CollectionStore) {
  const loopback = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    collections,
    policies: { notes: { read: () => undefined, write: () => true }, remote: { read: () => undefined } },
  })
  const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
  cleanups.unshift(() => client.close())
  cleanups.push(() => srv.close())
  return { srv, client }
}

describe('composeCollections — through a server', () => {
  it('streams a collection served by the non-default backend to a subscriber', async () => {
    const a = memoryCollections()
    const b = memoryCollections()
    const { srv, client } = boot(composeCollections({ default: a, remote: b }))
    await srv.collection('remote').insert(note('r1'))

    const sub = client.collection('remote').subscribe({})
    await sub.ready
    expect(sub.rows()).toEqual([note('r1')])

    await srv.collection('remote').insert(note('r2'))
    await client.collection('notes').insert(note('n1'))
    await waitFor(() => sub.rows().length === 2)
    expect(sub.rows().map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(b.read('remote', 'r2')).toEqual(note('r2'))
    expect(a.read('notes', 'n1')).toEqual(note('n1'))
    expect(a.read('remote', 'r2')).toBeUndefined()
  })

  it('refuses to start when it routes a name that is not a row collection on the contract', () => {
    expect(() => boot(composeCollections({ default: memoryCollections(), remotes: memoryCollections() }))).toThrow(
      /routes 'remotes'/,
    )
  })

  it('delivers a self backend feed to a subscriber of a mixed composite', async () => {
    const self = fakeSelf()
    const { srv, client } = boot(composeCollections({ default: memoryCollections(), remote: self.store }))

    const sub = client.collection('remote').subscribe({})
    await sub.ready
    self.feed.apply([insert('remote', 'r1')], 'source')
    await waitFor(() => sub.rows().length === 1)
    expect(sub.rows()).toEqual([note('r1')])
    await expect(srv.collection('remote').insert(note('r2'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
