import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientPluginContext } from '@super-line/client'
import { DEVTOOLS_GLOBAL, TAP_VERSION, devtoolsPlugin, devtoolsRegistry } from '@super-line/plugin-devtools'

// The registry is page-global by design, so each test starts from a clean page.
const resetPage = () => void delete (globalThis as Record<string, unknown>)[DEVTOOLS_GLOBAL]
beforeEach(resetPage)
afterEach(resetPage)

let idSeq = 0
function fakeCtx(role = 'user'): ClientPluginContext {
  return {
    clientId: `c${++idSeq}`,
    role,
    getPending: () => [],
    getTopics: () => [],
    getCollectionSubs: () => [],
    getOpenDocs: () => [],
    getDocSnapshot: () => undefined,
  }
}

/** Mount a plugin against a fake client and return a hand that emits frames. */
function mount(opts?: Parameters<typeof devtoolsPlugin>[0]) {
  const plugin = devtoolsPlugin(opts)
  const ctx = fakeCtx()
  const dispose = plugin.setup!(ctx)
  let i = 0
  return {
    ctx,
    dispose,
    emit: (payload: unknown = {}) =>
      plugin.onClientSideEvent!({ k: 'frame', dir: 'out', f: { t: 'req', i: ++i, m: 'hello', d: payload } as never, bytes: 10 }),
    plugin,
  }
}

const reg = () => devtoolsRegistry()!

describe('devtools registry', () => {
  it('is installed by the first plugin and adopted by the rest', () => {
    expect(devtoolsRegistry()).toBeUndefined()
    const a = mount()
    const first = reg()
    const b = mount()
    expect(reg()).toBe(first) // one buffer for the whole page, not one per client
    a.emit()
    b.emit()
    expect(reg().drain(0).records).toHaveLength(2)
  })

  it('tags every record with its client and one monotonic sequence across clients', () => {
    const a = mount()
    const b = mount()
    a.emit()
    b.emit()
    a.emit()
    const { records } = reg().drain(0)
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(records.map((r) => r.clientId)).toEqual([a.ctx.clientId, b.ctx.clientId, a.ctx.clientId])
  })

  it('drains only what is past the cursor', () => {
    const a = mount()
    a.emit()
    a.emit()
    const first = reg().drain(0)
    expect(first.records).toHaveLength(2)
    expect(first.cursor).toBe(2)

    expect(reg().drain(first.cursor).records).toHaveLength(0)
    a.emit()
    const second = reg().drain(first.cursor)
    expect(second.records).toHaveLength(1)
    expect(second.cursor).toBe(3)
  })

  it('holds the cursor steady when there is nothing new', () => {
    mount()
    expect(reg().drain(7).cursor).toBe(7)
  })

  it('caps a batch and says there is more, rather than returning everything at once', () => {
    const a = mount()
    for (let i = 0; i < 10; i++) a.emit()
    const batch = reg().drain(0, 4)
    expect(batch.records).toHaveLength(4)
    expect(batch.more).toBe(true)
    expect(batch.cursor).toBe(4)

    const rest = reg().drain(batch.cursor, 100)
    expect(rest.records).toHaveLength(6)
    expect(rest.more).toBe(false)
  })

  it('evicts oldest-first past capacity and REPORTS the loss rather than swallowing it', () => {
    const a = mount({ maxEvents: 10 })
    for (let i = 0; i < 40; i++) a.emit()

    const batch = reg().drain(0, 1000)
    expect(batch.records.length).toBeLessThanOrEqual(13) // capacity plus the trim slack
    expect(batch.dropped).toBeGreaterThan(0)
    // what survived is the TAIL: the newest record is always present
    expect(batch.records.at(-1)!.seq).toBe(40)
    // and the reported loss squares with what is missing
    expect(batch.dropped).toBe(batch.records[0]!.seq - 1)
  })

  it('reports no loss to a reader that kept up', () => {
    const a = mount({ maxEvents: 10 })
    for (let i = 0; i < 5; i++) a.emit()
    const first = reg().drain(0)
    expect(first.dropped).toBe(0)
    for (let i = 0; i < 5; i++) a.emit()
    expect(reg().drain(first.cursor).dropped).toBe(0)
  })

  it('stops reporting a gap once the reader has moved past it', () => {
    const a = mount({ maxEvents: 10 })
    for (let i = 0; i < 40; i++) a.emit()
    const first = reg().drain(0, 1000)
    expect(first.dropped).toBeGreaterThan(0)
    expect(reg().drain(first.cursor).dropped).toBe(0) // the gap is history, not a permanent condition
  })

  it('snapshots payloads at emit, so a later mutation cannot rewrite the record', () => {
    const a = mount()
    const payload = { text: 'original' }
    a.emit(payload)
    payload.text = 'mutated afterwards'
    const [record] = reg().drain(0).records
    expect((record!.event as { f: { d: { text: string } } }).f.d.text).toBe('original')
  })

  it('produces records that survive a JSON round-trip, whatever the payload held', () => {
    const a = mount()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    a.emit({ when: new Date(0), fn: () => {}, big: 3n, cyclic })
    expect(() => JSON.stringify(reg().drain(0))).not.toThrow()
  })

  it('masks redacted fields before they enter the buffer', () => {
    const a = mount({ redact: ['token'] })
    a.emit({ token: 'super-secret', keep: 'visible' })
    const [record] = reg().drain(0).records
    const d = (record!.event as { f: { d: Record<string, unknown> } }).f.d
    expect(d.token).toBe('[Redacted]')
    expect(d.keep).toBe('visible')
  })

  it('lists clients in build order and marks a closed one dead without losing its records', () => {
    const a = mount()
    const b = mount()
    a.emit()
    a.dispose!()

    const { clients, records } = reg().drain(0)
    expect(clients.map((c) => c.clientId)).toEqual([a.ctx.clientId, b.ctx.clientId])
    expect(clients[0]).toMatchObject({ alive: false, role: 'user' })
    expect(clients[1]).toMatchObject({ alive: true })
    expect(records).toHaveLength(1) // a dead client's history survives it
  })

  it('carries the tap version and a page-load id on every batch', () => {
    mount()
    const batch = reg().drain(0)
    expect(batch.tapVersion).toBe(TAP_VERSION)
    expect(batch.pageLoadId).toBeTruthy()
    expect(reg().drain(0).pageLoadId).toBe(batch.pageLoadId) // stable within a load
  })
})

describe('devtools registry — on-demand state', () => {
  it('pulls a client state snapshot through the accessors', () => {
    const plugin = devtoolsPlugin()
    const ctx: ClientPluginContext = {
      ...fakeCtx('admin'),
      getPending: () => [{ i: 1, method: 'slow', sent: true }],
      getTopics: () => [{ topic: 'room', listeners: 2, ready: true }],
      getCollectionSubs: () => [{ n: 'notes', sid: 1, query: {}, rows: [{ id: 'n1' }], settled: true }],
      getOpenDocs: () => [{ n: 'scenes', id: 's1', replicas: 1, settled: true, deleted: false }],
      getDocSnapshot: (n, id) => (n === 'scenes' && id === 's1' ? { title: 'live' } : undefined),
    }
    plugin.setup!(ctx)

    const snap = reg().inspect(ctx.clientId)!
    expect(snap).toMatchObject({ role: 'admin', alive: true })
    expect(snap.pending).toEqual([{ i: 1, method: 'slow', sent: true }])
    expect(snap.topics[0]).toMatchObject({ topic: 'room', listeners: 2 })
    expect(snap.collections[0]!.rows).toEqual([{ id: 'n1' }])
    // documents are listed WITHOUT contents: pulling every snapshot on every inspect would
    // serialize hot CRDT docs the reader may not even be looking at
    expect(snap.docs[0]).toMatchObject({ n: 'scenes', id: 's1' })
    expect(snap.docs[0]).not.toHaveProperty('snapshot')
  })

  it('returns document contents only when asked for them', () => {
    const plugin = devtoolsPlugin()
    const ctx: ClientPluginContext = {
      ...fakeCtx(),
      getDocSnapshot: (n, id) => (n === 'scenes' && id === 's1' ? { title: 'live' } : undefined),
    }
    plugin.setup!(ctx)
    expect(reg().docSnapshot(ctx.clientId, 'scenes', 's1')).toEqual({ title: 'live' })
    expect(reg().docSnapshot(ctx.clientId, 'scenes', 'missing')).toBeUndefined()
  })

  it('has nothing to say about a client it never saw', () => {
    mount()
    expect(reg().inspect('nope')).toBeUndefined()
  })
})
