import { describe, expect, it } from 'vitest'
import type { ClientTapEvent } from '@super-line/core'
import { applyOpFilter, toOperations, type OpEntry, type Operation } from '../src/lib/operations.js'
import type { Entry } from '../src/lib/reduce.js'

let seq = 0
let clock = 1_000
const row = (event: ClientTapEvent, over: Partial<{ ts: number; clientId: string }> = {}): Entry => ({
  type: 'row',
  seq: ++seq,
  ts: over.ts ?? (clock += 1),
  clientId: over.clientId ?? 'c1',
  event,
})
const reset = (): void => {
  seq = 0
  clock = 1_000
}

const out = (f: unknown, bytes = 10): ClientTapEvent => ({ k: 'frame', dir: 'out', f: f as never, bytes })
const inb = (f: unknown, bytes = 20): ClientTapEvent => ({ k: 'frame', dir: 'in', f: f as never, bytes })

const ops = (entries: Entry[]): Operation[] =>
  toOperations(entries).filter((e): e is Extract<OpEntry, { type: 'op' }> => e.type === 'op')

describe('toOperations — requests', () => {
  it('merges queued, sent and answered into ONE row carrying both times', () => {
    reset()
    const list = ops([
      row({ k: 'req.queued', i: 1, m: 'whoami' }, { ts: 1000 }),
      row(out({ t: 'req', i: 1, m: 'whoami', d: {} }, 40), { ts: 1022 }),
      row(inb({ t: 'res', i: 1, d: {} }, 90), { ts: 1040 }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      label: 'whoami',
      status: 'ok',
      queuedMs: 22, // invisible on the wire — the request existed before the socket would take it
      latencyMs: 18, // 1040 - 1022: from the send, so the queue wait is not counted twice
      reqBytes: 40,
      resBytes: 90,
    })
    expect(list[0]!.records).toHaveLength(3)
  })

  it('measures latency from the SEND, not from when the request was created', () => {
    reset()
    // caught against real traffic: a whoami that waited 65ms for a writable socket and was answered
    // 5ms after it left reported 70ms, blaming the server for the client's own backpressure
    const list = ops([
      row({ k: 'req.queued', i: 1, m: 'whoami' }, { ts: 1000 }),
      row(out({ t: 'req', i: 1, m: 'whoami' }), { ts: 1065 }),
      row(inb({ t: 'res', i: 1, d: {} }), { ts: 1070 }),
    ])
    expect(list[0]).toMatchObject({ queuedMs: 65, latencyMs: 5 })
  })

  it('exposes the correlation id so a reply can be named after what it answers', () => {
    reset()
    // it must survive the queued→sent adoption, whose first record is not a frame and has no id
    const list = ops([
      row({ k: 'req.queued', i: 7, m: 'whoami' }),
      row(out({ t: 'req', i: 7, m: 'whoami' })),
    ])
    expect(list[0]!.corr).toBe(7)
  })

  it('anchors the row at the request, not the response, so ordering stays true', () => {
    reset()
    const list = ops([
      row(out({ t: 'req', i: 1, m: 'slow' }), { ts: 1000 }),
      row(inb({ t: 'cchg', n: 'messages', k: 'insert', id: 'm1', d: {} }), { ts: 1002 }),
      row(inb({ t: 'res', i: 1, d: {} }), { ts: 1900 }),
    ])
    expect(list.map((o) => o.ts)).toEqual([1000, 1002])
    expect(list[0]!.latencyMs).toBe(900)
  })

  it('leaves an unanswered request pending', () => {
    reset()
    const list = ops([row(out({ t: 'req', i: 1, m: 'slow' }))])
    expect(list[0]).toMatchObject({ status: 'pending', label: 'slow' })
    expect(list[0]!.latencyMs).toBeUndefined()
  })

  it('marks a request answered with an error, carrying the code', () => {
    reset()
    const list = ops([
      row(out({ t: 'req', i: 1, m: 'deleteThing' })),
      row(inb({ t: 'err', i: 1, code: 'FORBIDDEN', m: 'nope' })),
    ])
    expect(list[0]).toMatchObject({ status: 'error', problem: true, error: 'FORBIDDEN — nope' })
  })

  it('marks a dropped request as failed with no round trip', () => {
    reset()
    const list = ops([
      row(out({ t: 'req', i: 1, m: 'slow' })),
      row({ k: 'req.dropped', i: 1, m: 'slow', why: 'disconnected' }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ status: 'error', problem: true })
    expect(list[0]!.latencyMs).toBeUndefined() // never answered, so there is nothing to time
  })

  it('does not cross-pair correlation ids between two clients', () => {
    reset()
    const list = ops([
      row(out({ t: 'req', i: 1, m: 'fromA' }), { clientId: 'c1' }),
      row(out({ t: 'req', i: 1, m: 'fromB' }), { clientId: 'c2' }),
      row(inb({ t: 'res', i: 1, d: {} }), { clientId: 'c2' }),
    ])
    expect(list.find((o) => o.label === 'fromA')!.status).toBe('pending')
    expect(list.find((o) => o.label === 'fromB')!.status).toBe('ok')
  })

  it('folds a server-to-client request and the reply the client sends back', () => {
    reset()
    const list = ops([
      row(inb({ t: 'sreq', i: 5, m: 'confirm', d: {} })),
      row(out({ t: 'sres', i: 5, d: {} })),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ op: 'server-request', dir: 'in', status: 'ok', label: 'server asks confirm' })
  })
})

describe('toOperations — collections', () => {
  it('names a collection subscribe and reports its snapshot size', () => {
    reset()
    const list = ops([
      row(out({ t: 'csub', i: 1, n: 'messages', s: 1, q: {} })),
      row(inb({ t: 'res', i: 1, d: [{}, {}, {}] })),
    ])
    expect(list).toHaveLength(1)
    // the first version rendered this as a bare `csub #1` with no collection at all
    expect(list[0]).toMatchObject({ label: 'subscribe messages', op: 'subscribe', status: 'ok', rows: 3 })
  })

  it('summarizes the subscription query so two subscriptions are tellable apart', () => {
    reset()
    const list = ops([
      row(out({ t: 'csub', i: 1, n: 'messages', s: 1, q: { filter: { op: 'eq', field: 'channelId', value: 'abc' } } })),
    ])
    expect(list[0]!.detail).toContain('channelId')
    expect(list[0]!.detail).toContain('abc')
  })

  it('folds a row change together with its per-subscription routing decisions', () => {
    reset()
    const list = ops([
      row(inb({ t: 'cchg', n: 'messages', k: 'insert', id: 'm1', d: {} })),
      row({ k: 'route', n: 'messages', sid: 1, id: 'm1', decision: 'insert' }),
      row({ k: 'route', n: 'messages', sid: 2, id: 'm1', decision: 'skip' }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'messages changed', op: 'change' })
    expect(list[0]!.children).toEqual(['sid 1 · insert', 'sid 2 · skip'])
  })

  it('does NOT nest a change under a request that happened to be open', () => {
    reset()
    const list = ops([
      row(out({ t: 'req', i: 1, m: 'sendMessage' }), { ts: 1000 }),
      row(inb({ t: 'cchg', n: 'messages', k: 'insert', id: 'm1', d: {} }), { ts: 1002 }),
      row(inb({ t: 'res', i: 1, d: {} }), { ts: 1009 }),
    ])
    // the client cannot prove the change came from this request — another writer looks identical
    expect(list).toHaveLength(2)
    expect(list.map((o) => o.label)).toEqual(['sendMessage', 'messages changed'])
    expect(list[0]!.children).toEqual([])
  })

  it('names a batch write by the collections it touches', () => {
    reset()
    const list = ops([
      row(out({ t: 'cbat', i: 1, ops: [{ op: 'insert', n: 'notes', id: 'n1', d: {} }] })),
      row(inb({ t: 'res', i: 1, d: null })),
    ])
    expect(list[0]).toMatchObject({ label: 'write notes', op: 'write', status: 'ok' })
  })
})

describe('toOperations — deliveries and documents', () => {
  it('folds an event with its listener count', () => {
    reset()
    const list = ops([
      row(inb({ t: 'evt', e: 'tick', d: {} })),
      row({ k: 'deliver', kind: 'event', name: 'tick', listeners: 0 }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'event tick', op: 'delivery', problem: true })
    expect(list[0]!.detail).toBe('no listeners') // a bug with no server-side symptom
  })

  it('folds a doc change with its replica count', () => {
    reset()
    const list = ops([
      row(inb({ t: 'cdchg', n: 'scenes', id: 's1', u: 'x', o: 'w1' })),
      row({ k: 'doc', n: 'scenes', id: 's1', replicas: 0 }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ problem: true })
    expect(list[0]!.detail).toContain('no open replica')
  })
})

describe('toOperations — structure', () => {
  it('passes dividers through so gaps survive the fold', () => {
    reset()
    const entries: Entry[] = [
      row(out({ t: 'req', i: 1, m: 'a' })),
      { type: 'divider', kind: 'dropped', seq: 1, count: 9 },
      row(out({ t: 'req', i: 2, m: 'b' })),
    ]
    const folded = toOperations(entries)
    expect(folded.filter((e) => e.type === 'divider')).toHaveLength(1)
  })

  it('classifies heartbeat so it can be hidden without hiding anything else', () => {
    reset()
    const list = ops([row(inb({ t: 'ping' })), row(out({ t: 'pong' }))])
    expect(list.every((o) => o.category === 'heartbeat')).toBe(true)
  })
})

describe('applyOpFilter', () => {
  const sample = (): OpEntry[] =>
    toOperations([
      row(out({ t: 'req', i: 1, m: 'sendMessage' }), { clientId: 'c1' }),
      row(inb({ t: 'err', i: 1, code: 'FORBIDDEN', m: 'no' }), { clientId: 'c1' }),
      row(out({ t: 'csub', i: 2, n: 'messages', s: 1, q: {} }), { clientId: 'c2' }),
      row(inb({ t: 'ping' }), { clientId: 'c1' }),
      { type: 'divider', kind: 'dropped', seq: 99, count: 4 },
    ])

  const opsOf = (list: OpEntry[]) => list.filter((e) => e.type === 'op')

  it('hides heartbeat unless asked for', () => {
    reset()
    expect(opsOf(applyOpFilter(sample(), {}))).toHaveLength(2)
    reset()
    expect(opsOf(applyOpFilter(sample(), { heartbeat: true }))).toHaveLength(3)
  })

  it('filters by category', () => {
    reset()
    expect(opsOf(applyOpFilter(sample(), { categories: ['collections'] }))).toHaveLength(1)
  })

  it('filters by client', () => {
    reset()
    expect(opsOf(applyOpFilter(sample(), { clientIds: ['c2'] }))).toHaveLength(1)
  })

  it('surfaces problems across every category on their own axis', () => {
    reset()
    const problems = opsOf(applyOpFilter(sample(), { problemsOnly: true }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ label: 'sendMessage', status: 'error' })
  })

  it('matches free text against the human label, not the wire token', () => {
    reset()
    expect(opsOf(applyOpFilter(sample(), { text: 'subscribe mess' }))).toHaveLength(1)
  })

  it('keeps dividers visible under every filter', () => {
    reset()
    const filtered = applyOpFilter(sample(), { categories: ['documents'] })
    expect(filtered.filter((e) => e.type === 'divider')).toHaveLength(1)
    expect(opsOf(filtered)).toHaveLength(0)
  })
})
