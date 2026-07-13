import { afterEach, describe, it, expect, vi } from 'vitest'
import { memoryCollections } from '@super-line/collections-memory'
import { eq, gte } from '@super-line/core'
import type { RowChange } from '@super-line/core'

const msg = (id: string, channelId: string, n: number) => ({ id, channelId, text: `m${n}`, likes: n })

describe('memoryCollections — apply', () => {
  it('inserts, updates, deletes and emits changes with prev/next', () => {
    const store = memoryCollections()
    const seen: RowChange[] = []
    store.onChange((c) => seen.push(c))

    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 1) }], 'o1')
    store.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 9) }], 'o1')
    store.apply([{ op: 'delete', n: 'messages', id: 'a' }], 'o1')

    expect(seen.map((c) => c.k)).toEqual(['insert', 'update', 'delete'])
    expect(seen[0]).toMatchObject({ k: 'insert', id: 'a', next: msg('a', 'general', 1), origin: 'o1' })
    expect(seen[1]).toMatchObject({ k: 'update', prev: msg('a', 'general', 1), next: msg('a', 'general', 9) })
    expect(seen[2]).toMatchObject({ k: 'delete', prev: msg('a', 'general', 9) })
    expect(seen[2]?.next).toBeUndefined()
  })

  it('rejects insert of an existing id (CONFLICT) and update/... of an absent id (NOT_FOUND)', () => {
    const store = memoryCollections()
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')
    expect(() => store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 2) }], 'o1')).toThrow(/exists/i)
    expect(() => store.apply([{ op: 'update', n: 'messages', id: 'z', row: msg('z', 'g', 1) }], 'o1')).toThrow(/no row/i)
  })

  it('delete of an absent id is a silent no-op', () => {
    const store = memoryCollections()
    const cb = vi.fn()
    store.onChange(cb)
    expect(store.apply([{ op: 'delete', n: 'messages', id: 'ghost' }], 'o1')).toEqual([])
    expect(cb).not.toHaveBeenCalled()
  })

  it('applies a batch atomically — a failing op rolls back earlier ops and emits nothing', () => {
    const store = memoryCollections()
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')
    const cb = vi.fn()
    store.onChange(cb)
    // op1 ok (insert b), op2 fails (insert existing a) → whole batch aborts
    expect(() =>
      store.apply(
        [
          { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'g', 2) },
          { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 3) },
        ],
        'o1',
      ),
    ).toThrow(/exists/i)
    expect(cb).not.toHaveBeenCalled()
    expect(store.read('messages', 'b')).toBeUndefined() // op1 rolled back
    expect(store.read('messages', 'a')).toEqual(msg('a', 'g', 1)) // untouched
  })

  it('supports intra-batch dependency (insert then update the same id)', () => {
    const store = memoryCollections()
    const changes = store.apply(
      [
        { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) },
        { op: 'update', n: 'messages', id: 'a', row: msg('a', 'g', 5) },
      ],
      'o1',
    ) as RowChange[]
    expect(changes.map((c) => c.k)).toEqual(['insert', 'update'])
    expect(store.read('messages', 'a')).toEqual(msg('a', 'g', 5))
  })

  it('spans collections in one atomic batch', () => {
    const store = memoryCollections()
    store.apply(
      [
        { op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } },
        { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) },
      ],
      'o1',
    )
    expect(store.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada' })
    expect(store.read('messages', 'a')).toEqual(msg('a', 'g', 1))
  })
})

describe('memoryCollections — snapshot', () => {
  it('filters, sorts, and paginates via the query IR', () => {
    const store = memoryCollections()
    store.apply(
      [
        { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 3) },
        { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'random', 1) },
        { op: 'insert', n: 'messages', id: 'c', row: msg('c', 'general', 2) },
        { op: 'insert', n: 'messages', id: 'd', row: msg('d', 'general', 5) },
      ],
      'o1',
    )
    const rows = store.snapshot('messages', {
      filter: eq('channelId', 'general'),
      orderBy: [{ field: 'likes', dir: 'desc' }],
      limit: 2,
    }) as ReturnType<typeof msg>[]
    expect(rows.map((r) => r.id)).toEqual(['d', 'a'])
  })

  it('an empty/unknown collection snapshots to []', () => {
    const store = memoryCollections()
    expect(store.snapshot('nope', {})).toEqual([])
    expect(store.snapshot('messages', { filter: gte('likes', 0) })).toEqual([])
  })
})

describe('memoryCollections — rowMeta (inspector-only timestamps)', () => {
  afterEach(() => vi.useRealTimers())

  it('stamps createdAt/updatedAt on insert; update bumps updatedAt but freezes createdAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000))
    const store = memoryCollections()
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')

    expect(await store.rowMeta!('messages', ['a'])).toEqual({ a: { createdAt: 1_000, updatedAt: 1_000 } })

    vi.setSystemTime(new Date(6_000))
    store.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'g', 9) }], 'o1')
    expect(await store.rowMeta!('messages', ['a'])).toEqual({ a: { createdAt: 1_000, updatedAt: 6_000 } }) // createdAt frozen
  })

  it('keeps snapshot/read row-pure — timestamps never leak into the client-facing row', () => {
    const store = memoryCollections()
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')
    expect(store.read('messages', 'a')).toEqual(msg('a', 'g', 1)) // no _createdAt/_updatedAt
    expect(store.snapshot('messages', {})).toEqual([msg('a', 'g', 1)])
  })

  it('rowMeta omits ids that do not exist', async () => {
    const store = memoryCollections()
    store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o1')
    const meta = await store.rowMeta!('messages', ['a', 'ghost'])
    expect(meta).toHaveProperty('a')
    expect(meta).not.toHaveProperty('ghost')
  })
})
