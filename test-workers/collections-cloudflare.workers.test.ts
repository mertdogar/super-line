import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { afterEach, aroundEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { cloudflareCollections } from '@super-line/collections-cloudflare'
import { createSuperLineClient } from '@super-line/client'
import { SuperLineError, and, eq, gte, ilike, isIn, like, neq } from '@super-line/core'
import type { CollectionDef, CollectionStore } from '@super-line/core'
import { runRowConformance } from '../packages/core/test/collection-store-conformance.js'
import { waitFor } from '../packages/core/test/wait.js'
import { appContract, stubTransport } from './app.js'

// collections-cloudflare in a real Durable Object. Its storage is usable only inside the object, so each test in
// the first block runs inside `runInDurableObject` on a fresh one — an empty database per test.

const defs: Record<string, CollectionDef> = {
  messages: { schema: z.object({ id: z.string(), channelId: z.string(), text: z.string(), likes: z.number() }), key: 'id' },
  users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  u: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  m: { schema: z.object({ id: z.string(), tag: z.string().nullable().optional() }), key: 'id' },
  ranked: { schema: z.object({ id: z.string(), rank: z.number().optional() }), key: 'id' },
  flags: { schema: z.object({ id: z.string(), on: z.boolean() }), key: 'id' },
}

const freshObject = () => env.STORE.get(env.STORE.idFromName(`store-${crypto.randomUUID()}`))
let storage: DurableObjectStorage
const make = (collections = defs) => cloudflareCollections(storage, collections)

const msg = (id: string, channelId: string, n: number) => ({ id, channelId, text: `m${n}`, likes: n })
const rows = (store: CollectionStore, n: string, query = {}) => store.snapshot(n, query) as ReturnType<typeof msg>[]
const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('collections-cloudflare in a fresh Durable Object', () => {
  aroundEach((runTest) =>
    runInDurableObject(freshObject(), async (_instance, state) => {
      storage = state.storage
      await runTest()
    }),
  )

  runRowConformance('collections-cloudflare', { make: () => make(), clustering: 'relay' })

  describe('snapshot (IR→SQL over typed columns + JS refine)', () => {
    const seed = (store: CollectionStore) =>
      store.apply(
        [
          { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 3) },
          { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'random', 1) },
          { op: 'insert', n: 'messages', id: 'c', row: msg('c', 'general', 2) },
          { op: 'insert', n: 'messages', id: 'd', row: msg('d', 'general', 5) },
        ],
        'o',
      )

    it('compiles in / comparison / and predicates against real columns', () => {
      const store = make()
      seed(store)
      expect(rows(store, 'messages', { filter: isIn('channelId', ['general']) }).map((r) => r.id).sort()).toEqual(['a', 'c', 'd'])
      expect(rows(store, 'messages', { filter: gte('likes', 3) }).map((r) => r.id).sort()).toEqual(['a', 'd'])
      expect(rows(store, 'messages', { filter: and(eq('channelId', 'general'), gte('likes', 3)) }).map((r) => r.id).sort()).toEqual(['a', 'd'])
    })

    it('pushes an exact query — filter, ORDER BY, LIMIT and OFFSET — entirely to SQL', () => {
      const store = make()
      seed(store)
      const page = rows(store, 'messages', { filter: eq('channelId', 'general'), orderBy: [{ field: 'likes', dir: 'desc' }], offset: 1, limit: 2 })
      expect(page.map((r) => r.id)).toEqual(['a', 'c'])
    })

    it('sorts missing numbers last on asc and first on desc (NULLS FIRST/LAST on the platform SQLite)', () => {
      const store = make()
      store.apply(
        [
          { op: 'insert', n: 'ranked', id: 'r2', row: { id: 'r2', rank: 2 } },
          { op: 'insert', n: 'ranked', id: 'none', row: { id: 'none' } },
          { op: 'insert', n: 'ranked', id: 'r1', row: { id: 'r1', rank: 1 } },
        ],
        'o',
      )
      const ids = (dir: 'asc' | 'desc') => (store.snapshot('ranked', { orderBy: [{ field: 'rank', dir }] }) as { id: string }[]).map((r) => r.id)
      expect(ids('asc')).toEqual(['r1', 'r2', 'none'])
      expect(ids('desc')).toEqual(['none', 'r2', 'r1'])
    })

    it('round-trips booleans through INTEGER storage and filters on them exactly', () => {
      const store = make()
      store.apply(
        [
          { op: 'insert', n: 'flags', id: 'y', row: { id: 'y', on: true } },
          { op: 'insert', n: 'flags', id: 'n', row: { id: 'n', on: false } },
        ],
        'o',
      )
      expect(store.read('flags', 'y')).toEqual({ id: 'y', on: true })
      expect((store.snapshot('flags', { filter: eq('on', true) }) as { id: string }[]).map((r) => r.id)).toEqual(['y'])
    })

    it('falls back to a JS scan for like/ilike, preserving case-sensitivity SQLite LIKE would lose', () => {
      const store = make()
      store.apply(
        [
          { op: 'insert', n: 'u', id: '1', row: { id: '1', name: 'Ada Lovelace' } },
          { op: 'insert', n: 'u', id: '2', row: { id: '2', name: 'Alan Turing' } },
        ],
        'o',
      )
      const names = (f: Parameters<CollectionStore['snapshot']>[1]) => (store.snapshot('u', f) as { name: string }[]).map((r) => r.name).sort()
      expect(names({ filter: like('name', 'Ada%') })).toEqual(['Ada Lovelace'])
      expect(names({ filter: like('name', 'ada%') })).toEqual([])
      expect(names({ filter: ilike('name', 'ada%') })).toEqual(['Ada Lovelace'])
    })

    it('distinguishes an explicit null from a missing field (JSON-demoted column, JS-exact)', () => {
      const store = make()
      store.apply(
        [
          { op: 'insert', n: 'm', id: 'hasNull', row: { id: 'hasNull', tag: null } },
          { op: 'insert', n: 'm', id: 'missing', row: { id: 'missing' } },
          { op: 'insert', n: 'm', id: 'hasVal', row: { id: 'hasVal', tag: 'x' } },
        ],
        'o',
      )
      expect(store.read('m', 'hasNull')).toEqual({ id: 'hasNull', tag: null })
      expect(store.read('m', 'missing')).toEqual({ id: 'missing' })
      expect((store.snapshot('m', { filter: eq('tag', null) }) as { id: string }[]).map((r) => r.id)).toEqual(['hasNull'])
      expect((store.snapshot('m', { filter: neq('tag', 'x') }) as { id: string }[]).map((r) => r.id).sort()).toEqual(['hasNull', 'missing'])
    })
  })

  describe('Durable Object limits', () => {
    it('answers a filter and a rowMeta over more values than one query can bind', () => {
      const store = make()
      store.apply(Array.from({ length: 150 }, (_, i) => ({ op: 'insert' as const, n: 'messages', id: `m${i}`, row: msg(`m${i}`, `c${i}`, i) })), 'o')
      const channels = Array.from({ length: 150 }, (_, i) => `c${i * 2}`) // 75 of them exist
      const page = rows(store, 'messages', { filter: isIn('channelId', channels), orderBy: [{ field: 'likes', dir: 'desc' }], limit: 3 })
      expect(page.map((r) => r.id)).toEqual(['m148', 'm146', 'm144'])
      const ids = Array.from({ length: 250 }, (_, i) => `m${i}`)
      expect(Object.keys(store.rowMeta!('messages', ids))).toHaveLength(150)
    })

    it('stores a 98-column row and refuses a 99-column collection without failing the others', () => {
      const wide = (fields: number): CollectionDef => ({
        schema: z.object({ id: z.string(), ...Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, z.number()])) }),
        key: 'id',
      })
      const store = make({ fits: wide(97), tooWide: wide(98), users: defs.users! })
      const row = { id: 'a', ...Object.fromEntries(Array.from({ length: 97 }, (_, i) => [`f${i}`, i])) }
      store.apply([{ op: 'insert', n: 'fits', id: 'a', row }], 'o') // 98 columns + 2 timestamps = 100 bound values
      expect(store.read('fits', 'a')).toEqual(row)

      const err = thrown(() => store.read('tooWide', 'a'))
      expect(err).toBeInstanceOf(SuperLineError)
      expect(err).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/collection 'tooWide' is unusable: plans 99 columns/) })
      store.apply([{ op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } }], 'o')
      expect(store.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada' })
    })

    it('keeps a SuperLineError code through the transaction that rolled back', () => {
      const store = make()
      store.apply([{ op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } }], 'o')
      const err = thrown(() => store.apply([{ op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } }], 'o'))
      expect(err).toBeInstanceOf(SuperLineError)
      expect(err).toMatchObject({ code: 'CONFLICT' })
    })
  })

  describe('schema drift (col_meta fingerprint)', () => {
    const notes = (schema: z.ZodTypeAny): Record<string, CollectionDef> => ({ notes: { schema, key: 'id' }, users: defs.users! })

    it('auto-adds new optional columns and keeps existing rows readable', () => {
      make(notes(z.object({ id: z.string() }))).apply([{ op: 'insert', n: 'notes', id: 'a', row: { id: 'a' } }], 'o')

      const s2 = make(notes(z.object({ id: z.string(), text: z.string().optional() })))
      expect(s2.read('notes', 'a')).toEqual({ id: 'a' })
      s2.apply([{ op: 'insert', n: 'notes', id: 'b', row: { id: 'b', text: 'hi' } }], 'o')
      expect(s2.read('notes', 'b')).toEqual({ id: 'b', text: 'hi' })
    })

    it('fails only the drifted collection, readably, and never at construction', () => {
      make(notes(z.object({ id: z.string(), n: z.number() }))).read('notes', 'x') // opens: records the fingerprint

      const changed = make(notes(z.object({ id: z.string(), n: z.string() }))) // must not throw
      expect(thrown(() => changed.read('notes', 'x'))).toMatchObject({
        code: 'INTERNAL',
        message: expect.stringMatching(/collection 'notes' is unusable: schema changed or removed field 'n' — rename the collection, or migrate table "col_notes"/),
      })
      changed.apply([{ op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } }], 'o')
      expect(changed.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada' })

      const required = make(notes(z.object({ id: z.string(), n: z.number(), req: z.string() })))
      expect(thrown(() => required.snapshot('notes', {}))).toMatchObject({ message: expect.stringMatching(/added required field 'req'/) })
    })
  })
})

describe('collections-cloudflare across eviction', () => {
  const clients: Array<{ close(): void }> = []
  afterEach(() => {
    for (const c of clients.splice(0)) c.close()
  })

  it('rows written before an eviction are read by the next instance', async () => {
    const stub = freshObject()
    await runInDurableObject(stub, (_i, state) => {
      cloudflareCollections(state.storage, defs).apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 1) }], 'o')
    })
    await evictDurableObject(stub)
    const read = await runInDurableObject(stub, (_i, state) => cloudflareCollections(state.storage, defs).read('messages', 'a'))
    expect(read).toEqual(msg('a', 'general', 1))
  })

  it('a live row subscription on a node survives a wake, and the woken node still has every row', async () => {
    const stub = env.APP.get(env.APP.idFromName(`app-${crypto.randomUUID()}`))
    const lifecycle: string[] = []
    const client = createSuperLineClient(appContract, {
      transport: stubTransport(stub),
      role: 'user',
      params: { uid: 'alice' },
      onDisconnect: (code) => lifecycle.push(`disconnect:${code}`),
      onReconnect: () => lifecycle.push('reconnect'),
    })
    clients.push(client)
    const notes = client.collection('notes')
    const live = notes.subscribe({})
    await live.ready
    await notes.insert({ id: 'n1', text: 'before' })
    await waitFor(() => live.rows().length === 1)

    await evictDurableObject(stub)
    await notes.insert({ id: 'n2', text: 'after' }) // this write is what wakes the object

    await waitFor(() => live.rows().length === 2)
    const again = notes.subscribe({})
    await again.ready
    expect(again.rows().map((r) => r.id).sort()).toEqual(['n1', 'n2'])
    expect(lifecycle).toEqual([])
  })
})
