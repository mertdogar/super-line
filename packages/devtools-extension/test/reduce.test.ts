import { describe, expect, it } from 'vitest'
import type { ClientTapEvent, ClientTapRecord } from '@super-line/core'
import type { DrainBatch } from '@super-line/plugin-devtools'
import { applyBatch, applyFilter, applyPushed, hasGap, initialState, type Entry } from '../src/lib/reduce.js'
import { eventName } from '../src/lib/labels.js'

const LOAD = 'load-a'

let seq = 0
const record = (event: ClientTapEvent, over: Partial<ClientTapRecord> = {}): ClientTapRecord => ({
  event,
  seq: ++seq,
  ts: 1_000 + seq,
  clientId: 'c1',
  ...over,
})

const batch = (records: ClientTapRecord[], over: Partial<DrainBatch> = {}): DrainBatch => ({
  tapVersion: 1,
  pageLoadId: LOAD,
  records,
  cursor: records.at(-1)?.seq ?? 0,
  dropped: 0,
  more: false,
  clients: [{ clientId: 'c1', role: 'user', alive: true }],
  ...over,
})

const req = (i: number, m = 'hello'): ClientTapEvent => ({
  k: 'frame',
  dir: 'out',
  f: { t: 'req', i, m, d: {} } as never,
  bytes: 20,
})
const res = (i: number): ClientTapEvent => ({ k: 'frame', dir: 'in', f: { t: 'res', i, d: {} } as never, bytes: 10 })
const err = (i: number): ClientTapEvent => ({
  k: 'frame',
  dir: 'in',
  f: { t: 'err', i, code: 'FORBIDDEN', m: 'no' } as never,
  bytes: 10,
})

const rows = (entries: Entry[]) => entries.filter((e): e is Extract<Entry, { type: 'row' }> => e.type === 'row')
const dividers = (entries: Entry[]) => entries.filter((e): e is Extract<Entry, { type: 'divider' }> => e.type === 'divider')

beforeEachReset()
function beforeEachReset() {
  seq = 0
}

describe('applyBatch — pairing', () => {
  it('pairs a response to its request and computes the round trip', () => {
    seq = 0
    const r = record(req(1))
    const s = record(res(1), { ts: r.ts + 42 })
    const state = applyBatch(initialState(), batch([r, s]))

    const request = rows(state.entries)[0]!
    expect(request.pending).toBe(false)
    expect(request.latencyMs).toBe(42)
  })

  it('pairs across separate batches, since a response usually arrives after the poll that saw the request', () => {
    seq = 0
    const r = record(req(1))
    let state = applyBatch(initialState(), batch([r]))
    expect(rows(state.entries)[0]!.pending).toBe(true)
    expect(state.inFlight).toHaveLength(1)

    const s = record(res(1), { ts: r.ts + 7 })
    state = applyBatch(state, batch([s]))
    expect(rows(state.entries)[0]!.latencyMs).toBe(7)
    expect(state.inFlight).toHaveLength(0)
  })

  it('settles a request answered with an error, not just a success', () => {
    seq = 0
    const r = record(req(1))
    const state = applyBatch(initialState(), batch([r, record(err(1), { ts: r.ts + 5 })]))
    expect(rows(state.entries)[0]!.pending).toBe(false)
    expect(state.inFlight).toHaveLength(0)
  })

  it('does not cross-pair correlation ids between two clients on the same page', () => {
    seq = 0
    // both clients number their requests from 1 — a page runs several clients at once
    const a = record(req(1, 'fromA'), { clientId: 'c1' })
    const b = record(req(1, 'fromB'), { clientId: 'c2' })
    const answerB = record(res(1), { clientId: 'c2', ts: 9_000 })
    const state = applyBatch(
      initialState(),
      batch([a, b, answerB], {
        clients: [
          { clientId: 'c1', role: 'user', alive: true },
          { clientId: 'c2', role: 'user', alive: true },
        ],
      }),
    )
    const [rowA, rowB] = rows(state.entries)
    expect(rowA!.pending).toBe(true) // c1's request is untouched by c2's response
    expect(rowB!.pending).toBe(false)
    expect(state.inFlight.map((f) => f.clientId)).toEqual(['c1'])
  })

  it('clears in-flight requests when the connection drops, and settles the row', () => {
    seq = 0
    const state = applyBatch(
      initialState(),
      batch([
        record(req(1, 'slow')),
        record({ k: 'req.dropped', i: 1, m: 'slow', why: 'disconnected' }),
        record({ k: 'conn', phase: 'close', code: 1006 }),
      ]),
    )
    expect(state.inFlight).toHaveLength(0)
    expect(rows(state.entries)[0]!.pending).toBe(false)
    expect(rows(state.entries)[0]!.latencyMs).toBeUndefined() // never answered, so it has no round trip
  })

  it('tracks a request queued behind an unwritable socket as in-flight but unsent', () => {
    seq = 0
    const state = applyBatch(initialState(), batch([record({ k: 'req.queued', i: 4, m: 'hello' })]))
    expect(state.inFlight[0]).toMatchObject({ i: 4, method: 'hello', sent: false })
  })
})

describe('applyBatch — sequence reconciliation', () => {
  it('ignores records at or below the cursor, so poll and push can both deliver one', () => {
    seq = 0
    const first = [record(req(1)), record(res(1))]
    let state = applyBatch(initialState(), batch(first))
    expect(rows(state.entries)).toHaveLength(2)

    // the same records arriving again — the push path racing the poll
    state = applyBatch(state, batch(first))
    expect(rows(state.entries)).toHaveLength(2)
  })

  it('advances the cursor to the last record it consumed', () => {
    seq = 0
    const state = applyBatch(initialState(), batch([record(req(1)), record(res(1))]))
    expect(state.cursor).toBe(2)
  })

  it('detects a gap so the caller knows to re-drain', () => {
    const state = { ...initialState(), cursor: 10 }
    expect(hasGap(state, 11)).toBe(false) // the very next record
    expect(hasGap(state, 14)).toBe(true) // three missing
    expect(hasGap(initialState(), 99)).toBe(false) // a fresh panel has not missed anything
  })
})

describe('applyPushed — push reconciled against poll', () => {
  it('folds a record that follows the cursor exactly', () => {
    seq = 0
    const state = applyBatch(initialState(), batch([record(req(1))]))
    const next = applyPushed(state, record(res(1)))!
    expect(next).not.toBeNull()
    expect(rows(next.entries)).toHaveLength(2)
    expect(next.cursor).toBe(2)
  })

  it('refuses a duplicate the poll already folded', () => {
    seq = 0
    const dup = record(req(1))
    const state = applyBatch(initialState(), batch([dup]))
    expect(applyPushed(state, dup)).toBeNull()
  })

  it('refuses a record past a gap, leaving repair to the poll', () => {
    seq = 0
    const state = applyBatch(initialState(), batch([record(req(1))]))
    seq = 40
    expect(applyPushed(state, record(res(1)))).toBeNull()
  })

  it('refuses anything before the first drain establishes a page load', () => {
    seq = 0
    expect(applyPushed(initialState(), record(req(1)))).toBeNull()
  })

  it('pairs a pushed response against a polled request', () => {
    seq = 0
    const r = record(req(1))
    const state = applyBatch(initialState(), batch([r]))
    const next = applyPushed(state, record(res(1), { ts: r.ts + 11 }))!
    expect(rows(next.entries)[0]!.latencyMs).toBe(11)
    expect(next.inFlight).toHaveLength(0)
  })
})

describe('applyBatch — dropped records', () => {
  it('renders an eviction as a visible divider rather than swallowing it', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1))]))
    state = applyBatch(state, batch([record(res(1))], { dropped: 37 }))

    const gap = dividers(state.entries).find((d) => d.kind === 'dropped')
    expect(gap).toMatchObject({ kind: 'dropped', count: 37 })
    expect(state.droppedTotal).toBe(37)
  })

  it('accumulates the session total across batches', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1))], { dropped: 5 }))
    state = applyBatch(state, batch([record(res(1))], { dropped: 3 }))
    expect(state.droppedTotal).toBe(8)
  })
})

describe('applyBatch — page loads', () => {
  it('marks a reload with a divider and keeps prior history when preserving', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1)), record(res(1))]))
    expect(rows(state.entries)).toHaveLength(2)

    // a reload restarts the page sequence at 1, which would otherwise read as a gap
    seq = 0
    state = applyBatch(state, batch([record(req(1))], { pageLoadId: 'load-b' }), true)
    expect(dividers(state.entries).some((d) => d.kind === 'page-load')).toBe(true)
    expect(rows(state.entries)).toHaveLength(3) // old history retained
    expect(state.pageLoadId).toBe('load-b')
  })

  it('clears history on reload when not preserving', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1)), record(res(1))]))
    seq = 0
    state = applyBatch(state, batch([record(req(1))], { pageLoadId: 'load-b' }), false)
    expect(rows(state.entries)).toHaveLength(1)
  })

  it('accepts a restarted sequence after reload rather than dropping it as already-seen', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1)), record(res(1)), record(req(2))]))
    expect(state.cursor).toBe(3)

    // seq 1 is BELOW the cursor, but it belongs to a new load and must not be deduped away
    seq = 0
    state = applyBatch(state, batch([record(req(1), { clientId: 'c9' })], { pageLoadId: 'load-b' }), true)
    expect(rows(state.entries).at(-1)!.clientId).toBe('c9')
  })

  it('drops in-flight requests belonging to the previous load', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1, 'slow'))]))
    expect(state.inFlight).toHaveLength(1)
    seq = 0
    state = applyBatch(state, batch([], { pageLoadId: 'load-b', cursor: 0 }), true)
    expect(state.inFlight).toHaveLength(0)
  })
})

describe('applyBatch — client state rail', () => {
  it('folds connection phase into a status', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record({ k: 'conn', phase: 'open' })]))
    expect(state.clients[0]).toMatchObject({ status: 'open' })

    state = applyBatch(state, batch([record({ k: 'conn', phase: 'close', code: 1006 })]))
    expect(state.clients[0]).toMatchObject({ status: 'closed', code: 1006 })

    state = applyBatch(state, batch([record({ k: 'conn', phase: 'retry', attempt: 2, delayMs: 1000 })]))
    expect(state.clients[0]).toMatchObject({ status: 'retrying', attempt: 2, delayMs: 1000 })
  })

  it('clears the retry countdown once the connection reopens', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record({ k: 'conn', phase: 'retry', attempt: 3, delayMs: 4000 })]))
    state = applyBatch(state, batch([record({ k: 'conn', phase: 'open' })]))
    expect(state.clients[0]).toMatchObject({ status: 'open', attempt: undefined, delayMs: undefined })
  })

  it('keeps a closed client listed so its history still reads', () => {
    seq = 0
    const state = applyBatch(
      initialState(),
      batch([record(req(1))], { clients: [{ clientId: 'c1', role: 'user', alive: false }] }),
    )
    expect(state.clients[0]).toMatchObject({ clientId: 'c1', alive: false })
  })
})

describe('applyBatch — version guard', () => {
  it('warns rather than rendering records it may not understand', () => {
    seq = 0
    const state = applyBatch(initialState(), batch([record(req(1))], { tapVersion: 99 }))
    expect(state.versionWarning).toContain('99')
    expect(state.versionWarning).toContain('1')
  })

  it('says nothing when the versions agree', () => {
    seq = 0
    expect(applyBatch(initialState(), batch([record(req(1))])).versionWarning).toBeUndefined()
  })
})

describe('labels and filtering', () => {
  it('names every event kind without falling through', () => {
    const all: ClientTapEvent[] = [
      req(1),
      { k: 'req.queued', i: 1, m: 'hello' },
      { k: 'req.dropped', i: 1, m: 'hello', why: 'timeout' },
      { k: 'deliver', kind: 'topic', name: 'room', listeners: 0 },
      { k: 'validate.fail', kind: 'event', name: 'tick', message: 'bad' },
      { k: 'route', n: 'notes', sid: 1, id: 'n1', decision: 'left-filter' },
      { k: 'conn', phase: 'retry', attempt: 1, delayMs: 500 },
      { k: 'doc', n: 'scenes', id: 's1', replicas: 0 },
    ]
    for (const event of all) expect(eventName(event).label).toBeTruthy()
    expect(eventName(all[5]!).label).toBe('notes left-filter')
  })

  it('filters by client, category and free text', () => {
    seq = 0
    const state = applyBatch(
      initialState(),
      batch(
        [
          record(req(1, 'sendMessage'), { clientId: 'c1' }),
          record({ k: 'conn', phase: 'open' }, { clientId: 'c2' }),
          record(req(2, 'deleteThing'), { clientId: 'c2' }),
        ],
        {
          clients: [
            { clientId: 'c1', role: 'user', alive: true },
            { clientId: 'c2', role: 'user', alive: true },
          ],
        },
      ),
    )

    expect(rows(applyFilter(state.entries, { clientIds: ['c2'] }))).toHaveLength(2)
    expect(rows(applyFilter(state.entries, { categories: ['connection'] }))).toHaveLength(1)
    expect(rows(applyFilter(state.entries, { text: 'sendmess' }))).toHaveLength(1)
    expect(rows(applyFilter(state.entries, {}))).toHaveLength(3)
  })

  it('keeps gap dividers visible under every filter, so a filtered view never looks complete when it is not', () => {
    seq = 0
    let state = applyBatch(initialState(), batch([record(req(1, 'kept'))]))
    state = applyBatch(state, batch([record(req(2, 'other'))], { dropped: 12 }))
    const filtered = applyFilter(state.entries, { text: 'kept' })
    expect(dividers(filtered)).toHaveLength(1)
  })
})
