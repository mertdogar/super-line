import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { eq, gte, isIn, like, ilike, and, neq } from '@super-line/core'
import type { CollectionStore, RowChange } from '@super-line/core'

const msg = (id: string, channelId: string, n: number, extra: Record<string, unknown> = {}) => ({ id, channelId, text: `m${n}`, likes: n, ...extra })
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

describe('sqliteCollections — apply parity', () => {
  it('inserts/updates/deletes atomically and emits prev/next changes', () => {
    const store = sqliteCollections({ file: ':memory:' })
    const seen: RowChange[] = []
    store.onChange((c) => seen.push(c))
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')
    store.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'g', 9) }], 'o1')
    store.apply([{ op: 'delete', n: 'messages', id: 'a' }], 'o1')
    expect(seen.map((c) => c.k)).toEqual(['insert', 'update', 'delete'])
    expect(seen[1]).toMatchObject({ prev: msg('a', 'g', 1), next: msg('a', 'g', 9) })
    expect(seen[2]).toMatchObject({ k: 'delete', prev: msg('a', 'g', 9) })
    store.close?.()
  })

  it('rejects duplicate insert / missing update and rolls a failed batch back', () => {
    const store = sqliteCollections({ file: ':memory:' })
    store.apply([{ op: 'insert', n: 'm', id: 'a', row: msg('a', 'g', 1) }], 'o')
    expect(() => store.apply([{ op: 'insert', n: 'm', id: 'a', row: msg('a', 'g', 2) }], 'o')).toThrow(/exists/i)
    expect(() => store.apply([{ op: 'update', n: 'm', id: 'z', row: msg('z', 'g', 1) }], 'o')).toThrow(/no row/i)
    // atomic: op1 ok, op2 fails → both rolled back
    expect(() =>
      store.apply(
        [
          { op: 'insert', n: 'm', id: 'b', row: msg('b', 'g', 2) },
          { op: 'insert', n: 'm', id: 'a', row: msg('a', 'g', 3) },
        ],
        'o',
      ),
    ).toThrow(/exists/i)
    expect(store.read('m', 'b')).toBeUndefined()
    store.close?.()
  })
})

describe('sqliteCollections — snapshot (IR→SQL pushdown + JS refine)', () => {
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

  it('filters + sorts + limits via a compilable filter (eq + orderBy + limit)', () => {
    const store = sqliteCollections({ file: ':memory:' })
    seed(store)
    const out = rows(store, 'messages', { filter: eq('channelId', 'general'), orderBy: [{ field: 'likes', dir: 'desc' }], limit: 2 })
    expect(out.map((r) => r.id)).toEqual(['d', 'a'])
    store.close?.()
  })

  it('compiles in / comparison / and predicates', () => {
    const store = sqliteCollections({ file: ':memory:' })
    seed(store)
    expect(rows(store, 'messages', { filter: isIn('channelId', ['general']) }).map((r) => r.id).sort()).toEqual(['a', 'c', 'd'])
    expect(rows(store, 'messages', { filter: gte('likes', 3) }).map((r) => r.id).sort()).toEqual(['a', 'd'])
    expect(rows(store, 'messages', { filter: and(eq('channelId', 'general'), gte('likes', 3)) }).map((r) => r.id).sort()).toEqual(['a', 'd'])
    store.close?.()
  })

  it('falls back to a JS scan for like/ilike, preserving case-sensitivity SQLite LIKE would lose', () => {
    const store = sqliteCollections({ file: ':memory:' })
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

  it('distinguishes an explicit null from a missing field (SQL superset, JS-exact)', () => {
    const store = sqliteCollections({ file: ':memory:' })
    store.apply(
      [
        { op: 'insert', n: 'm', id: 'hasNull', row: { id: 'hasNull', tag: null } },
        { op: 'insert', n: 'm', id: 'missing', row: { id: 'missing' } },
        { op: 'insert', n: 'm', id: 'hasVal', row: { id: 'hasVal', tag: 'x' } },
      ],
      'o',
    )
    expect((store.snapshot('m', { filter: eq('tag', null) }) as { id: string }[]).map((r) => r.id)).toEqual(['hasNull'])
    expect((store.snapshot('m', { filter: neq('tag', 'x') }) as { id: string }[]).map((r) => r.id).sort()).toEqual(['hasNull', 'missing'])
    store.close?.()
  })
})

describe('sqliteCollections — durability', () => {
  it('persists rows across a reopen of the same file', () => {
    const file = tmpFile()
    const s1 = sqliteCollections({ file })
    s1.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 1) }], 'o')
    s1.close?.()

    const s2 = sqliteCollections({ file })
    expect(s2.read('messages', 'a')).toEqual(msg('a', 'general', 1))
    expect(rows(s2, 'messages', { filter: eq('channelId', 'general') }).map((r) => r.id)).toEqual(['a'])
    s2.close?.()
  })
})
