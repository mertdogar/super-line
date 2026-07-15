import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { eq, gte, isIn, like, ilike, and, neq } from '@super-line/core'
import type { CollectionStore } from '@super-line/core'
import { runRowConformance } from '../../core/test/collection-store-conformance.js'

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

// The seam's contract — apply/atomicity/query-IR/rowMeta/relay — is asserted once, for every backend.
runRowConformance('collections-sqlite', { make: () => sqliteCollections({ file: ':memory:' }), clustering: 'relay' })

// Below: only what is genuinely sqlite's, not the seam's.

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

  it('migrates a pre-timestamp table in place and backfills existing rows with the upgrade time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(50_000))
    try {
      const file = tmpFile()
      // Simulate an old durable store: the original (collection, id, data)-only schema, with a row already in it.
      const legacy = new Database(file)
      legacy.exec(`CREATE TABLE "collection_rows" (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))`)
      legacy.prepare(`INSERT INTO "collection_rows" (collection, id, data) VALUES (?, ?, ?)`).run('messages', 'old', JSON.stringify(msg('old', 'g', 1)))
      legacy.close()

      const store = sqliteCollections({ file }) // triggers ALTER + backfill at upgrade time
      expect(store.read('messages', 'old')).toEqual(msg('old', 'g', 1)) // row survives untouched
      expect((await store.rowMeta!('messages', ['old'])).old).toEqual({ createdAt: 50_000, updatedAt: 50_000 })
      store.close?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
