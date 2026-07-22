import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { eq, jsonSerializer, type CollectionDef, type Expr, type RowChange } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { createCollectionRuntime, type CollectionConn, type CollectionHost } from '@super-line/server'

// Unit tests for the Collection runtime, driven straight through its interface: no server, no transport, no
// TCP port, no sockets, no waitFor. Before the extraction the only way to reach `route`'s filter predicate was
// an http server + a bound port + a WebSocket handshake + ~53 lines of scaffolding (see
// collections.integration.test.ts:1-54) — for logic that is pure `andFilters`/`orFilters`/`matchesFilter`.

type Msg = { id: string; channelId: string; authorId: string; text: string }

const defs: Record<string, CollectionDef> = {
  users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  messages: {
    schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string() }),
    key: 'id',
    references: { authorId: 'users' },
  },
  scenes: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } },
} as unknown as Record<string, CollectionDef>

const msg = (id: string, channelId = 'general', authorId = 'u1'): Msg => ({ id, channelId, authorId, text: id })

/** A connection is six fields. The real Conn class satisfies this; a test does not need one. */
function conn(id: string, principal = id): CollectionConn & { sent: unknown[]; raw: unknown[] } {
  const sent: unknown[] = []
  const raw: unknown[] = []
  return {
    id,
    role: 'user',
    ctx: { userId: principal },
    principal,
    sent,
    raw,
    send: (f) => sent.push(f),
    sendRaw: (p) => raw.push(p),
  }
}

/** Every host capability is fakeable in a line — that is the claim the extraction was making. */
function host(over: Partial<CollectionHost> = {}): CollectionHost & { published: Array<{ channel: string; frame: object }> } {
  const published: Array<{ channel: string; frame: object }> = []
  return {
    published,
    dispatch: (_c, _i, _info, terminal) => terminal(), // no middleware, and a throw propagates to the caller
    cluster: {
      broadcast: (channel, frame) => published.push({ channel, frame }),
      receive: (payload) => {
        const data = jsonSerializer.decode(payload)
        return { data, raw: payload, from: 'other', own: false }
      },
    },
    channels: { join: () => {}, leave: () => {}, membersOf: () => undefined },
    tap: () => {},
    encode: (f) => jsonSerializer.encode(f),
    ...over,
  } as CollectionHost & { published: Array<{ channel: string; frame: object }> }
}

const openPolicy = { read: () => undefined, write: () => true }

function runtime(policies: Record<string, unknown>, h: CollectionHost = host(), checkReferences = false) {
  const store = memoryCollections()
  const r = createCollectionRuntime({ store, defs, policies, checkReferences }, h)
  return { r, store }
}

const sub = (n: string, s: number, filter?: Expr) => ({ t: 'csub' as const, i: 1, n, s, q: { filter } })
const batch = (ops: unknown[]) => ({ t: 'cbat' as const, i: 2, ops }) as never

describe('Collection runtime · row change routing', () => {
  // The predicate: policy read-filter ∧ (OR of the conn's subscription filters), evaluated against the pre-op
  // AND post-op row. Five lines in rows.ts encoding four rules, previously reachable only through a socket.
  async function subscribed(filter: Expr | undefined, policy?: Expr) {
    const { r, store } = runtime({ messages: { read: () => policy, write: () => true } })
    const c = conn('c1')
    await r.onSub(c, sub('messages', 1, filter) as never)
    c.sent.length = 0
    return { r, store, c }
  }

  const delivered = (c: { sent: unknown[] }) => c.sent.filter((f) => (f as { t: string }).t === 'cchg')

  it('delivers a row that matches the subscription filter, and withholds one that does not', async () => {
    const { store, c } = await subscribed(eq('channelId', 'general'))
    await store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1', 'general') }], 'u1')
    await store.apply([{ op: 'insert', n: 'messages', id: 'm2', row: msg('m2', 'random') }], 'u1')
    expect(delivered(c)).toMatchObject([{ n: 'messages', k: 'insert', id: 'm1' }])
  })

  it('ANDs the policy read-filter into the subscription filter', async () => {
    // subscribed to all of #general, but policy only admits your own rows
    const { store, c } = await subscribed(eq('channelId', 'general'), eq('authorId', 'c1'))
    await store.apply([{ op: 'insert', n: 'messages', id: 'mine', row: msg('mine', 'general', 'c1') }], 'x')
    await store.apply([{ op: 'insert', n: 'messages', id: 'theirs', row: msg('theirs', 'general', 'u9') }], 'x')
    expect(delivered(c)).toMatchObject([{ id: 'mine' }])
  })

  it('delivers a row that LEAVES the filter on update, so the client can remove it (pre-op OR post-op)', async () => {
    const { store, c } = await subscribed(eq('channelId', 'general'))
    await store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1', 'general') }], 'u1')
    c.sent.length = 0
    // m1 moves out of #general: it matches pre-op but not post-op — it must still be delivered
    await store.apply([{ op: 'update', n: 'messages', id: 'm1', row: msg('m1', 'random') }], 'u1')
    expect(delivered(c)).toMatchObject([{ k: 'update', id: 'm1' }])
  })

  it('ORs multiple subscriptions on one connection', async () => {
    const { r, store } = runtime({ messages: openPolicy })
    const c = conn('c1')
    await r.onSub(c, sub('messages', 1, eq('channelId', 'general')) as never)
    await r.onSub(c, sub('messages', 2, eq('channelId', 'random')) as never)
    c.sent.length = 0
    await store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general') }], 'u1')
    await store.apply([{ op: 'insert', n: 'messages', id: 'b', row: msg('b', 'random') }], 'u1')
    await store.apply([{ op: 'insert', n: 'messages', id: 'c', row: msg('c', 'other') }], 'u1')
    expect(delivered(c).map((f) => (f as { id: string }).id)).toEqual(['a', 'b'])
  })

  // orFilters is the one combinator with INVERTED undefined semantics, its only production call site is this
  // predicate, and before this file it had zero tests anywhere in the repo. A `some`→`every` slip here leaks
  // every row past its policy filter.
  it('treats an unfiltered subscription as match-all, so it dominates a filtered sibling', async () => {
    const { r, store } = runtime({ messages: openPolicy })
    const c = conn('c1')
    await r.onSub(c, sub('messages', 1, eq('channelId', 'general')) as never)
    await r.onSub(c, sub('messages', 2, undefined) as never) // no filter ⇒ match everything
    c.sent.length = 0
    await store.apply([{ op: 'insert', n: 'messages', id: 'x', row: msg('x', 'anywhere') }], 'u1')
    expect(delivered(c)).toMatchObject([{ id: 'x' }]) // the union is match-all, not just #general
  })

  it('still applies the policy filter when a subscription is unfiltered', async () => {
    // the match-all subscription must not dissolve the policy: andFilters(policy, undefined) === policy
    const { store, c } = await subscribed(undefined, eq('authorId', 'c1'))
    await store.apply([{ op: 'insert', n: 'messages', id: 'mine', row: msg('mine', 'g', 'c1') }], 'x')
    await store.apply([{ op: 'insert', n: 'messages', id: 'theirs', row: msg('theirs', 'g', 'u9') }], 'x')
    expect(delivered(c)).toMatchObject([{ id: 'mine' }])
  })

  it('stops delivering after unsubscribe, and after the connection detaches', async () => {
    const { r, store } = runtime({ messages: openPolicy })
    const c = conn('c1')
    await r.onSub(c, sub('messages', 1) as never)
    c.sent.length = 0
    r.onUnsub(c, { t: 'cuns', n: 'messages', s: 1 } as never)
    await store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'u1')
    expect(delivered(c)).toEqual([])

    await r.onSub(c, sub('messages', 2) as never)
    c.sent.length = 0
    r.detach(c)
    await store.apply([{ op: 'insert', n: 'messages', id: 'b', row: msg('b') }], 'u1')
    expect(delivered(c)).toEqual([])
  })

  // A `self` backend (collections-pglite) surfaces a delete via its Electric feed WITHOUT the prior row, so the
  // predicate cannot filter it and must broadcast to every subscriber. Reproducing that with the real thing
  // costs Postgres + Electric + two containers; through the seam it costs a nine-line fake store.
  it('broadcasts a prevless delete to every subscriber, even one whose policy admits nothing', async () => {
    const listeners = new Set<(c: RowChange) => void>()
    const feed = {
      clustering: 'self' as const,
      apply: () => {}, // `self`: apply returns nothing and fires no onChange — the feed does (ADR-0009)
      snapshot: () => [],
      read: () => undefined,
      onChange: (cb: (c: RowChange) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const r = createCollectionRuntime(
      { store: feed, defs, policies: { messages: { read: () => eq('channelId', 'nope'), write: () => true } }, checkReferences: false },
      host(),
    )
    const c = conn('c1')
    await r.onSub(c, sub('messages', 1) as never)
    c.sent.length = 0

    const emit = (ch: RowChange) => listeners.forEach((l) => l(ch))
    // prev AND next absent: unmatchable, so it must go to everyone (the client removes-if-present)
    emit({ n: 'messages', k: 'delete', id: 'gone', origin: 'x' } as RowChange)
    expect(delivered(c)).toMatchObject([{ k: 'delete', id: 'gone' }])

    c.sent.length = 0
    // whereas a delete that DOES carry prev is filterable — and this policy rejects it
    emit({ n: 'messages', k: 'delete', id: 'z', prev: msg('z', 'general'), origin: 'x' } as RowChange)
    expect(delivered(c)).toEqual([])
  })
})

describe('Collection runtime · policy is deny-by-default', () => {
  it('denies a read when the collection has no policy at all', async () => {
    const { r } = runtime({})
    const c = conn('c1')
    await expect(r.onSub(c, sub('messages', 1) as never)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('denies a read when the policy omits `read`', async () => {
    const { r } = runtime({ messages: { write: () => true } })
    const c = conn('c1')
    await expect(r.onSub(c, sub('messages', 1) as never)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('denies a write when the policy omits `write`', async () => {
    const { r } = runtime({ messages: { read: () => undefined } })
    const c = conn('c1')
    await expect(
      r.onBatch(c, batch([{ op: 'insert', n: 'messages', id: 'm1', d: msg('m1') }])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('denies a CRDT open when the policy omits `read`', async () => {
    const crdtStore = crdtMemoryCollections()
    const r = createCollectionRuntime(
      { crdtStore, defs, policies: { scenes: { write: () => true } }, checkReferences: false },
      host(),
    )
    await (r.handle('scenes') as { create: (id: string, d: unknown) => Promise<void> }).create('s1', { title: 'x' })
    await expect(r.onCrdtOpen(conn('c1'), { t: 'cdopen', i: 1, n: 'scenes', id: 's1' } as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('denies a CRDT write when the policy omits `write`', async () => {
    const crdtStore = crdtMemoryCollections()
    const r = createCollectionRuntime(
      { crdtStore, defs, policies: { scenes: { read: () => true } }, checkReferences: false },
      host(),
    )
    await (r.handle('scenes') as { create: (id: string, d: unknown) => Promise<void> }).create('s1', { title: 'x' })
    await expect(
      r.onCrdtWrite(conn('c1'), { t: 'cdwr', i: 1, n: 'scenes', id: 's1', u: 'AAA', o: 'w1' } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('opening a document that does not exist is NOT_FOUND — creation is server-authoritative', async () => {
    const crdtStore = crdtMemoryCollections()
    const r = createCollectionRuntime(
      { crdtStore, defs, policies: { scenes: { read: () => true, write: () => true } }, checkReferences: false },
      host(),
    )
    await expect(r.onCrdtOpen(conn('c1'), { t: 'cdopen', i: 1, n: 'scenes', id: 'ghost' } as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('passes the principal and ctx through to the policy', async () => {
    const read = vi.fn(() => undefined)
    const { r } = runtime({ messages: { read, write: () => true } })
    await r.onSub(conn('c1', 'alice'), sub('messages', 1) as never)
    expect(read).toHaveBeenCalledWith('alice', { userId: 'alice' })
  })

  it('falls back to the connection id when no principal was identified', async () => {
    const read = vi.fn(() => undefined)
    const { r } = runtime({ messages: { read, write: () => true } })
    const c = conn('c9')
    ;(c as { principal?: string }).principal = undefined
    await r.onSub(c, sub('messages', 1) as never)
    expect(read).toHaveBeenCalledWith('c9', expect.anything())
  })
})

describe('Collection runtime · batch resolution', () => {
  const withWrite = (write: unknown) => runtime({ messages: { read: () => undefined, write }, users: openPolicy })

  it('rejects an unknown collection', async () => {
    const { r } = withWrite(() => true)
    await expect(r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'nope', id: 'x', d: {} }]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects a row batch aimed at a CRDT collection', async () => {
    const { r } = runtime({ scenes: openPolicy })
    await expect(
      r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'scenes', id: 's1', d: { title: 'x' } }])),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects a row whose key does not match the op id', async () => {
    const { r } = withWrite(() => true)
    await expect(
      r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'messages', id: 'WRONG', d: msg('m1') }])),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects a row that fails its schema', async () => {
    const { r } = withWrite(() => true)
    await expect(
      r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'messages', id: 'm1', d: { id: 'm1', text: 5 } }])),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('hands the write policy the incoming row and the previous one', async () => {
    const write = vi.fn(() => true)
    const { r, store } = withWrite(write)
    await store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1', 'general') }], 'seed')
    await r.onBatch(conn('c1', 'alice'), batch([{ op: 'update', n: 'messages', id: 'm1', d: msg('m1', 'random') }]))
    expect(write).toHaveBeenCalledWith(
      'alice',
      'update',
      expect.objectContaining({ channelId: 'random' }), // next
      expect.objectContaining({ channelId: 'general' }), // prev
      expect.anything(),
    )
  })

  it('aborts the WHOLE batch when one op is denied — nothing is applied', async () => {
    const { r, store } = withWrite((_p: string, _op: string, next: Msg | undefined) => next?.id !== 'bad')
    await expect(
      r.onBatch(
        conn('c1'),
        batch([
          { op: 'insert', n: 'messages', id: 'good', d: msg('good') },
          { op: 'insert', n: 'messages', id: 'bad', d: msg('bad') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await store.read('messages', 'good')).toBeUndefined() // the permitted op did not sneak through
  })

  it('rejects a dangling advisory reference only when checkReferences is on', async () => {
    const off = runtime({ messages: { read: () => undefined, write: () => true }, users: openPolicy }, host(), false)
    await off.r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'messages', id: 'm1', d: msg('m1', 'g', 'ghost') }]))
    expect(await off.store.read('messages', 'm1')).toBeDefined() // FK unchecked by default

    const on = runtime({ messages: { read: () => undefined, write: () => true }, users: openPolicy }, host(), true)
    await expect(
      on.r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'messages', id: 'm2', d: msg('m2', 'g', 'ghost') }])),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('Collection runtime · relay', () => {
  let h: ReturnType<typeof host>
  beforeEach(() => {
    h = host()
  })

  it('broadcasts a committed batch to the cluster under a relay backend', async () => {
    const { r } = runtime({ messages: openPolicy }, h)
    await r.onBatch(conn('c1'), batch([{ op: 'insert', n: 'messages', id: 'm1', d: msg('m1') }]))
    expect(h.published).toMatchObject([{ channel: 'cbatch', frame: { origin: 'c1' } }])
  })

  it('drops its own looped-back batch instead of re-applying it (deliver-at-source)', async () => {
    const ownHost = host({
      cluster: {
        broadcast: () => {},
        receive: (payload) => ({ data: jsonSerializer.decode(payload), raw: payload, from: 'me', own: true }),
      },
    })
    const { r, store } = runtime({ messages: openPolicy }, ownHost)
    const applied = vi.spyOn(store, 'apply')
    r.onRelay(jsonSerializer.encode({ ops: [{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1') }], origin: 'x' }))
    expect(applied).not.toHaveBeenCalled()
  })

  it('applies a foreign batch so this node converges', async () => {
    const { r, store } = runtime({ messages: openPolicy }, h)
    r.onRelay(jsonSerializer.encode({ ops: [{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1') }], origin: 'x' }))
    expect(await store.read('messages', 'm1')).toMatchObject({ id: 'm1' })
  })

  it('swallows a cross-node race (a duplicate insert) rather than throwing at the demux', () => {
    const { r } = runtime({ messages: openPolicy }, h)
    const relay = jsonSerializer.encode({
      ops: [{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1') }],
      origin: 'x',
    })
    r.onRelay(relay)
    expect(() => r.onRelay(relay)).not.toThrow() // second apply CONFLICTs; it converges on the next write
  })
})

describe('Collection runtime · server handle + infos', () => {
  it('reports every declared collection, giving CRDT documents a synthetic id key', () => {
    const { r } = runtime({})
    expect(r.infos()).toEqual([
      { name: 'users', key: 'id', references: {} },
      { name: 'messages', key: 'id', references: { authorId: 'users' } },
      { name: 'scenes', key: 'id', references: {} }, // CRDT: open-by-id, not row-queryable
    ])
  })

  it('throws on an undeclared collection', () => {
    const { r } = runtime({})
    expect(() => r.handle('ghost')).toThrow(/not declared/)
  })

  it('co-writes bypass the policy but still validate, and still relay', async () => {
    const h2 = host()
    const { r, store } = runtime({ messages: { read: () => undefined } }, h2) // no `write` ⇒ clients denied
    await (r.handle('messages') as { insert: (r: Msg) => Promise<void> }).insert(msg('m1'))
    expect(await store.read('messages', 'm1')).toMatchObject({ id: 'm1' })
    expect(h2.published).toMatchObject([{ channel: 'cbatch', frame: { origin: 'server' } }])
    await expect((r.handle('messages') as { insert: (r: unknown) => Promise<void> }).insert({ id: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('applies server co-writes atomically across row collections', async () => {
    const h2 = host()
    const { r, store } = runtime({}, h2)
    await r.batch([
      { op: 'insert', collection: 'users', row: { id: 'u1', name: 'Ann' } },
      { op: 'insert', collection: 'messages', row: msg('m1', 'general', 'u1') },
    ])
    expect(await store.read('users', 'u1')).toMatchObject({ name: 'Ann' })
    expect(await store.read('messages', 'm1')).toMatchObject({ authorId: 'u1' })
    expect(h2.published).toHaveLength(1)

    await expect(
      r.batch([
        { op: 'insert', collection: 'users', row: { id: 'orphan', name: 'Nope' } },
        { op: 'insert', collection: 'messages', row: msg('m1') },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await store.read('users', 'orphan')).toBeUndefined()
  })
})
