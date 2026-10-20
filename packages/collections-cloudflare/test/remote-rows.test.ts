import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as z from 'zod'
import { and, defineContract, eq, gt, isIn, type RowChange, type RowOf } from '@super-line/core'
import { remoteRows, type RemoteRowsStorage } from '../src/remote-rows.js'
import { remoteRowSchema, remoteRowsCollection, type RemoteRowsRow } from '../src/contract.js'
import type { RemoteChange, RemoteChanges, RemotePush, RemoteRow } from '../src/synced-sql.js'

// remoteRows against an in-memory source and storage: the clock bookkeeping, snapshots and refusals. The hop between
// two real Durable Objects is test-workers/remote-rows.workers.test.ts.

function memoryStorage(): RemoteRowsStorage {
  const map = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => void map.set(key, value),
  }
}

/** A source at `head`: a pull from its clock or later answers `wipeAll` with the clock, as syncedSql does. */
function fakeSource(rows: RemoteRow[] = []) {
  const source = {
    head: { epoch: 'e1', clock: 0, changes: [], wipeAll: false } as RemoteChanges,
    pulls: [] as number[],
    snapshot: vi.fn((table: string, limit: number) => rows.filter((r) => r.table === table).slice(0, limit)),
    get: (table: string, id: string) => rows.find((r) => r.table === table && r.id === id),
    changesSince(clock: number): RemoteChanges {
      source.pulls.push(clock)
      return clock > source.head.clock ? { ...source.head, changes: [], wipeAll: true } : source.head
    },
  }
  return source
}

function setup(rows?: RemoteRow[], storage = memoryStorage()) {
  const source = fakeSource(rows)
  const wipes: string[] = []
  const store = remoteRows({ collection: 'storeRows', storage, stub: () => source, onWipe: (id) => wipes.push(id), snapshotLimit: 50 })
  const changes: RowChange[] = []
  store.onChange((c) => changes.push(c))
  return { source, store, wipes, changes, storage }
}

const dish = (id: string, name: string): RemoteRow => ({ table: 'dishes', id, data: { id, name } })
const put = (id: string, name: string): RemoteChange => ({ ...dish(id, name), op: 'put' })
const push = (clock: number, changes?: RemoteChange[], epoch = 'e1'): RemotePush => ({ epoch, clock, changes })
const pinned = { filter: and(eq('storeId', 's1'), eq('table', 'dishes')) }
const ids = (rows: unknown[]) => (rows as RemoteRowsRow[]).map((r) => r.id)

describe('remoteRowsCollection', () => {
  it('merges one read-only row collection keyed `key` into the contract', () => {
    const contract = defineContract({
      roles: { user: {} },
      plugins: [remoteRowsCollection('storeRows'), remoteRowsCollection('archive')],
    })
    expect(contract.collections.storeRows).toEqual({ schema: remoteRowSchema, key: 'key' })
    expect(Object.keys(contract.collections)).toEqual(['storeRows', 'archive'])
    expectTypeOf<RowOf<typeof contract, 'storeRows'>>().toEqualTypeOf<RemoteRowsRow>()
    expectTypeOf<RemoteRowsRow['data']>().toEqualTypeOf<RemoteRow['data']>()
    const row = { key: 's1:t:1', storeId: 's1', table: 't', id: '1', data: { n: 1, s: 'x', z: null, b: { blob: 'AA==' } } }
    expect(remoteRowSchema.parse(row)).toEqual(row)
    expect(() =>
      defineContract({
        roles: { user: {} },
        collections: { storeRows: { schema: z.object({ id: z.string() }), key: 'id' } },
        plugins: [remoteRowsCollection('storeRows')],
      }),
    ).toThrow(/collides/)
  })
})

describe('remoteRows ingest', () => {
  it('ignores a store until its first subscribe, then applies each next clock inline', async () => {
    const { source, store, changes } = setup([dish('a', 'soup')])
    source.head = { ...source.head, clock: 1 }
    await store.ingest('s1', push(1, [put('a', 'soup')]))
    expect(changes).toEqual([])
    expect(source.pulls).toEqual([])

    await store.snapshot('storeRows', pinned)
    await store.ingest('s1', push(2, [put('b', 'bread'), { table: 'dishes', id: 'a', op: 'delete' }]))
    expect(changes).toEqual([
      { n: 'storeRows', k: 'update', id: 's1:dishes:b', next: { key: 's1:dishes:b', storeId: 's1', table: 'dishes', id: 'b', data: { id: 'b', name: 'bread' } }, origin: 's1' },
      { n: 'storeRows', k: 'delete', id: 's1:dishes:a', origin: 's1' },
    ])
    expect(source.pulls).toEqual([Number.MAX_SAFE_INTEGER])
  })

  it('drops a clock it already has, and pulls on a gap or a clock-only push', async () => {
    const { source, store, changes } = setup()
    source.head = { ...source.head, clock: 3 }
    await store.snapshot('storeRows', pinned)

    await store.ingest('s1', push(3, [put('x', 'stale')]))
    expect(changes).toEqual([])

    source.head = { epoch: 'e1', clock: 5, changes: [put('a', 'soup')], wipeAll: false }
    await store.ingest('s1', push(5, [put('a', 'soup')]))
    expect(source.pulls.at(-1)).toBe(3)
    expect(changes.map((c) => c.id)).toEqual(['s1:dishes:a'])

    source.head = { epoch: 'e1', clock: 6, changes: [put('b', 'bread')], wipeAll: false }
    await store.ingest('s1', push(6))
    expect(source.pulls.at(-1)).toBe(5)
    expect(changes.map((c) => c.id)).toEqual(['s1:dishes:a', 's1:dishes:b'])
  })

  it('a wipeAll pull or a new epoch calls onWipe instead of applying, and moves the clock on', async () => {
    const { source, store, changes, wipes } = setup()
    await store.snapshot('storeRows', pinned)

    source.head = { epoch: 'e1', clock: 2, changes: [], wipeAll: true }
    await store.ingest('s1', push(2))
    expect(wipes).toEqual(['s1'])
    source.head = { epoch: 'e1', clock: 3, changes: [], wipeAll: false }
    await store.ingest('s1', push(3, [put('a', 'soup')]))
    expect(changes.map((c) => c.id)).toEqual(['s1:dishes:a'])

    source.head = { epoch: 'e2', clock: 1, changes: [put('n', 'new')], wipeAll: false }
    await store.ingest('s1', push(1, [put('n', 'new')], 'e2'))
    expect(wipes).toEqual(['s1', 's1'])
    expect(changes).toHaveLength(1)
    await store.ingest('s1', push(2, [put('m', 'more')], 'e2'))
    expect(changes.map((c) => c.id)).toEqual(['s1:dishes:a', 's1:dishes:m'])
  })

  it('runs one step at a time per store, so a push behind a pull finds its clock covered', async () => {
    const { source, store, changes } = setup()
    await store.snapshot('storeRows', pinned)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const changesSince = source.changesSince.bind(source)
    source.changesSince = vi.fn(async (clock: number) => {
      await gate
      return changesSince(clock)
    }) as never
    source.head = { epoch: 'e1', clock: 3, changes: [put('a', 'v3')], wipeAll: false }

    const gap = store.ingest('s1', push(2))
    const next = store.ingest('s1', push(3, [put('a', 'v3')]))
    release()
    await Promise.all([gap, next])
    expect(changes.map((c) => (c.next as RemoteRowsRow).data.name)).toEqual(['v3'])
  })

  it('keeps its clock in storage, so a new instance on it carries on; resume pulls what it missed', async () => {
    const storage = memoryStorage()
    const first = setup([], storage)
    await first.store.snapshot('storeRows', pinned)

    const woken = setup([], storage)
    await woken.store.ingest('s1', push(1, [put('a', 'soup')]))
    expect(woken.changes.map((c) => c.id)).toEqual(['s1:dishes:a'])

    woken.source.head = { epoch: 'e1', clock: 2, changes: [put('b', 'bread')], wipeAll: false }
    await woken.store.resume(['s1'])
    expect(woken.source.pulls).toEqual([1])
    expect(woken.changes.map((c) => c.id)).toEqual(['s1:dishes:a', 's1:dishes:b'])
  })
})

describe('remoteRows reads', () => {
  const rows = [dish('a', 'soup'), dish('b', 'bread'), dish('c', 'cake'), { table: 'drinks', id: 'w', data: { id: 'w' } }]

  it('refuses a snapshot that does not pin storeId and table by equality', async () => {
    const { store } = setup(rows)
    for (const filter of [undefined, eq('storeId', 's1'), and(isIn('storeId', ['s1']), eq('table', 'dishes'))])
      await expect(store.snapshot('storeRows', { filter })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('pulls first, reads the pinned table and runs the rest of the query on it', async () => {
    const { source, store } = setup(rows)
    expect(await store.snapshot('storeRows', pinned)).toEqual([
      { key: 's1:dishes:a', storeId: 's1', table: 'dishes', id: 'a', data: { id: 'a', name: 'soup' } },
      { key: 's1:dishes:b', storeId: 's1', table: 'dishes', id: 'b', data: { id: 'b', name: 'bread' } },
      { key: 's1:dishes:c', storeId: 's1', table: 'dishes', id: 'c', data: { id: 'c', name: 'cake' } },
    ])
    expect(source.pulls).toHaveLength(1)
    expect(source.snapshot).toHaveBeenLastCalledWith('dishes', 50)

    const sorted = await store.snapshot('storeRows', { ...pinned, orderBy: [{ field: 'data.name', dir: 'asc' }], limit: 2 })
    expect(ids(sorted)).toEqual(['b', 'c'])
    expect(source.snapshot).toHaveBeenLastCalledWith('dishes', 50)

    const filtered = await store.snapshot('storeRows', { filter: and(pinned.filter, gt('data.name', 'd')), limit: 1 })
    expect(ids(filtered)).toEqual(['a'])
    expect(source.snapshot).toHaveBeenLastCalledWith('dishes', 50)

    expect(ids(await store.snapshot('storeRows', { ...pinned, limit: 1, offset: 1 }))).toEqual(['b'])
    expect(source.snapshot).toHaveBeenLastCalledWith('dishes', 2)
    expect(source.pulls).toHaveLength(4)
  })

  it('reads one row by key, which may hold colons past the table', async () => {
    const { store } = setup([...rows, dish('x:y', 'odd')])
    expect(await store.read('storeRows', 's1:dishes:x:y')).toMatchObject({ key: 's1:dishes:x:y', id: 'x:y' })
    expect(await store.read('storeRows', 's1:dishes:nope')).toBeUndefined()
    expect(await store.read('storeRows', 'no-colons')).toBeUndefined()
  })

  it('is read-only', () => {
    const { store } = setup()
    expect(() => store.apply([{ op: 'delete', n: 'storeRows', id: 's1:dishes:a' }], 'o')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => store.conditionalApply([], [], 'o')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(store.clustering).toBe('self')
  })
})
