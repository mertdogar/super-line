import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { eq, gte, isIn, like, ilike, and, neq } from '@super-line/core'
import type { CollectionDef, CollectionStore } from '@super-line/core'

import { runRowConformance } from '../../core/test/collection-store-conformance.js'

const defs: Record<string, CollectionDef> = {
  messages: { schema: z.object({ id: z.string(), channelId: z.string(), text: z.string(), likes: z.number() }), key: 'id' },
  users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  u: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  // optional AND nullable — planColumns demotes to a JSON column so missing ≠ null survives storage
  m: { schema: z.object({ id: z.string(), tag: z.string().nullable().optional() }), key: 'id' },
  ranked: { schema: z.object({ id: z.string(), rank: z.number().optional() }), key: 'id' },
  flags: { schema: z.object({ id: z.string(), on: z.boolean() }), key: 'id' },
}
const make = (file = ':memory:') => sqliteCollections({ file, collections: defs })

const msg = (id: string, channelId: string, n: number) => ({ id, channelId, text: `m${n}`, likes: n })
const rows = (store: CollectionStore, n: string, query = {}) => store.snapshot(n, query) as ReturnType<typeof msg>[]

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sl-coll-'))
  dirs.push(d)
  return join(d, 'test.db')
}

// The seam's contract — apply/atomicity/query-IR/rowMeta/relay — is asserted once, for every backend.
runRowConformance('collections-sqlite', { make: () => make(), clustering: 'relay' })

// Below: only what is genuinely sqlite's, not the seam's.

describe('sqliteCollections — snapshot (IR→SQL over typed columns + JS refine)', () => {
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
    store.close?.()
  })

  it('pushes an exact query — filter, ORDER BY, LIMIT and OFFSET — entirely to SQL', () => {
    const store = make()
    seed(store)
    const page = rows(store, 'messages', {
      filter: eq('channelId', 'general'),
      orderBy: [{ field: 'likes', dir: 'desc' }],
      offset: 1,
      limit: 2,
    })
    expect(page.map((r) => r.id)).toEqual(['a', 'c']) // 5(d) skipped by offset, then 3(a), 2(c)
    store.close?.()
  })

  it('sorts missing numbers last on asc and first on desc, like the evaluator', () => {
    const store = make()
    store.apply(
      [
        { op: 'insert', n: 'ranked', id: 'r2', row: { id: 'r2', rank: 2 } },
        { op: 'insert', n: 'ranked', id: 'none', row: { id: 'none' } },
        { op: 'insert', n: 'ranked', id: 'r1', row: { id: 'r1', rank: 1 } },
      ],
      'o',
    )
    const ids = (dir: 'asc' | 'desc') =>
      (store.snapshot('ranked', { orderBy: [{ field: 'rank', dir }] }) as { id: string }[]).map((r) => r.id)
    expect(ids('asc')).toEqual(['r1', 'r2', 'none'])
    expect(ids('desc')).toEqual(['none', 'r2', 'r1'])
    store.close?.()
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
    store.close?.()
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
    expect(names({ filter: like('name', 'ada%') })).toEqual([]) // case-sensitive: no match
    expect(names({ filter: ilike('name', 'ada%') })).toEqual(['Ada Lovelace']) // case-insensitive
    store.close?.()
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
    store.close?.()
  })
})

describe('sqliteCollections — durability', () => {
  it('persists rows across a reopen of the same file', () => {
    const file = tmpFile()
    const s1 = make(file)
    s1.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 1) }], 'o')
    s1.close?.()

    const s2 = make(file)
    expect(s2.read('messages', 'a')).toEqual(msg('a', 'general', 1))
    expect(rows(s2, 'messages', { filter: eq('channelId', 'general') }).map((r) => r.id)).toEqual(['a'])
    s2.close?.()
  })
})

describe('sqliteCollections — schema drift (col_meta fingerprint)', () => {
  const notes = (schema: z.ZodTypeAny): Record<string, CollectionDef> => ({ notes: { schema, key: 'id' } })

  it('auto-adds new optional columns and keeps existing rows readable', () => {
    const file = tmpFile()
    const s1 = sqliteCollections({ file, collections: notes(z.object({ id: z.string() })) })
    s1.apply([{ op: 'insert', n: 'notes', id: 'a', row: { id: 'a' } }], 'o')
    s1.close?.()

    const s2 = sqliteCollections({ file, collections: notes(z.object({ id: z.string(), text: z.string().optional() })) })
    expect(s2.read('notes', 'a')).toEqual({ id: 'a' }) // old row: new column reads as absent
    s2.apply([{ op: 'insert', n: 'notes', id: 'b', row: { id: 'b', text: 'hi' } }], 'o')
    expect(s2.read('notes', 'b')).toEqual({ id: 'b', text: 'hi' })
    s2.close?.()
  })

  it('refuses to boot when a field changes type or a required field is added', () => {
    const file = tmpFile()
    const s1 = sqliteCollections({ file, collections: notes(z.object({ id: z.string(), n: z.number() })) })
    s1.close?.()

    expect(() => sqliteCollections({ file, collections: notes(z.object({ id: z.string(), n: z.string() })) })).toThrow(
      /changed or removed field 'n'/,
    )
    expect(() =>
      sqliteCollections({ file, collections: notes(z.object({ id: z.string(), n: z.number(), req: z.string() })) }),
    ).toThrow(/added required field 'req'/)
  })
})
