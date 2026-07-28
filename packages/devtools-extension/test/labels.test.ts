import { describe, expect, it } from 'vitest'
import type { ClientTapEvent, Frame } from '@super-line/core'
import { categoryOf, eventName, formatBytes, frameName, isProblem, summarizeQuery } from '../src/lib/labels.js'

/** Every wire frame type, so a new one cannot slip through unnamed. */
const ALL_FRAMES: Frame[] = [
  { t: 'req', i: 1, m: 'sendMessage', d: {} },
  { t: 'res', i: 1, d: {} },
  { t: 'err', i: 1, code: 'FORBIDDEN', m: 'no' },
  { t: 'sub', i: 1, c: 'room' },
  { t: 'unsub', c: 'room' },
  { t: 'evt', e: 'tick', d: {} },
  { t: 'pub', c: 'room', d: {} },
  { t: 'env', d: {} },
  { t: 'sreq', i: 1, m: 'confirm', d: {} },
  { t: 'sres', i: 1, d: {} },
  { t: 'serr', i: 1, code: 'X', m: 'y' },
  { t: 'csub', i: 1, n: 'messages', s: 1, q: {} },
  { t: 'cuns', n: 'messages', s: 1 },
  { t: 'cbat', i: 1, ops: [{ op: 'insert', n: 'notes', id: 'n1', d: {} }] },
  { t: 'cchg', n: 'messages', k: 'insert', id: 'm1', d: {} },
  { t: 'cdopen', i: 1, n: 'scenes', id: 's1' },
  { t: 'cdwr', i: 1, n: 'scenes', id: 's1', u: 'x', o: 'w' },
  { t: 'cdchg', n: 'scenes', id: 's1', u: 'x', o: 'w' },
  { t: 'cddel', n: 'scenes', id: 's1' },
  { t: 'cdclose', n: 'scenes', id: 's1' },
  { t: 'ping' },
  { t: 'pong' },
]

describe('frameName', () => {
  it('names every wire frame type, and always keeps the wire token', () => {
    for (const f of ALL_FRAMES) {
      const named = frameName(f)
      expect(named.label, `label for ${f.t}`).toBeTruthy()
      expect(named.wire, `wire chip for ${f.t}`).toBe(f.t)
      // the label must not just BE the wire token — that is the thing people called cryptic
      if (f.t !== 'ping' && f.t !== 'pong') expect(named.label).not.toBe(f.t)
    }
  })

  it('carries the collection name a subscribe frame always had', () => {
    // the first version rendered this as a bare `csub #1`
    expect(frameName({ t: 'csub', i: 1, n: 'messages', s: 1, q: {} }).label).toBe('subscribe messages')
    expect(frameName({ t: 'cchg', n: 'messages', k: 'insert', id: 'm1', d: {} }).label).toBe('messages changed')
  })

  it('names a response by the request it answers, when the caller has paired them', () => {
    expect(frameName({ t: 'res', i: 2, d: {} }).label).toBe('response')
    expect(frameName({ t: 'res', i: 2, d: {} }, 'subscribe messages').label).toBe('response · subscribe messages')
    expect(frameName({ t: 'err', i: 2, code: 'X', m: 'y' }, 'sendMessage').label).toBe('failed · sendMessage')
  })

  it('names a batch by the collections it touches', () => {
    const named = frameName({
      t: 'cbat',
      i: 1,
      ops: [
        { op: 'insert', n: 'notes', id: 'a', d: {} },
        { op: 'delete', n: 'tags', id: 'b' },
      ],
    })
    expect(named.label).toBe('write notes, tags')
    expect(named.detail).toBe('2 ops')
  })
})

describe('summarizeQuery', () => {
  it('renders a filter compactly enough to tell two subscriptions apart', () => {
    expect(summarizeQuery({ filter: { op: 'eq', field: 'channelId', value: 'abc' } })).toBe('channelId eq abc')
  })

  it('handles compound expressions and limits', () => {
    const s = summarizeQuery({
      filter: { op: 'and', exprs: [{ op: 'eq', field: 'a', value: 1 }, { op: 'gt', field: 'b', value: 2 }] },
      limit: 50,
    })
    expect(s).toContain('and')
    expect(s).toContain('limit 50')
  })

  it('says nothing for an empty query rather than rendering noise', () => {
    expect(summarizeQuery({})).toBeUndefined()
    expect(summarizeQuery(undefined)).toBeUndefined()
  })
})

describe('categoryOf', () => {
  it('assigns every frame type a category', () => {
    for (const f of ALL_FRAMES) {
      expect(categoryOf({ k: 'frame', dir: 'in', f, bytes: 1 }), `category for ${f.t}`).toBeTruthy()
    }
  })

  it('groups by what a reader is looking for, not by wire shape', () => {
    expect(categoryOf({ k: 'frame', dir: 'out', f: ALL_FRAMES[0]!, bytes: 1 })).toBe('requests')
    expect(categoryOf({ k: 'route', n: 'm', sid: 1, id: 'x', decision: 'insert' })).toBe('collections')
    expect(categoryOf({ k: 'doc', n: 'scenes', id: 's1', replicas: 1 })).toBe('documents')
    expect(categoryOf({ k: 'conn', phase: 'open' })).toBe('connection')
    expect(categoryOf({ k: 'frame', dir: 'in', f: { t: 'ping' }, bytes: 1 })).toBe('heartbeat')
  })

  it('files a validation failure under whatever it was validating', () => {
    expect(categoryOf({ k: 'validate.fail', kind: 'response', name: 'x', message: 'm' })).toBe('requests')
    expect(categoryOf({ k: 'validate.fail', kind: 'topic', name: 'x', message: 'm' })).toBe('subscriptions')
  })
})

describe('isProblem', () => {
  const problems: ClientTapEvent[] = [
    { k: 'frame', dir: 'in', f: { t: 'err', i: 1, code: 'X', m: 'y' }, bytes: 1 },
    { k: 'req.dropped', i: 1, m: 'a', why: 'timeout' },
    { k: 'validate.fail', kind: 'event', name: 'tick', message: 'bad' },
    { k: 'deliver', kind: 'event', name: 'tick', listeners: 0 },
    { k: 'doc', n: 'scenes', id: 's1', replicas: 0 },
    { k: 'conn', phase: 'close', code: 1006 },
  ]
  const fine: ClientTapEvent[] = [
    { k: 'frame', dir: 'out', f: { t: 'req', i: 1, m: 'a', d: {} }, bytes: 1 },
    { k: 'deliver', kind: 'event', name: 'tick', listeners: 2 },
    { k: 'doc', n: 'scenes', id: 's1', replicas: 1 },
    { k: 'conn', phase: 'open' },
  ]

  it('flags failures across every category', () => {
    for (const e of problems) expect(isProblem(e), JSON.stringify(e)).toBe(true)
  })

  it('leaves healthy traffic alone', () => {
    for (const e of fine) expect(isProblem(e), JSON.stringify(e)).toBe(false)
  })

  it('treats a delivery with no listeners as a problem — it has no other symptom', () => {
    expect(isProblem({ k: 'deliver', kind: 'topic', name: 'room', listeners: 0 })).toBe(true)
  })
})

describe('eventName', () => {
  it('explains a queued request in words rather than a wire token', () => {
    const named = eventName({ k: 'req.queued', i: 1, m: 'whoami' })
    expect(named.label).toBe('whoami')
    expect(named.detail).toContain('writable')
  })

  it('spells out why a request was dropped', () => {
    expect(eventName({ k: 'req.dropped', i: 1, m: 'a', why: 'timeout' }).detail).toBe('timed out')
    expect(eventName({ k: 'req.dropped', i: 1, m: 'a', why: 'disconnected' }).detail).toContain('closed')
  })

  it('singularizes counts', () => {
    expect(eventName({ k: 'deliver', kind: 'event', name: 'x', listeners: 1 }).detail).toBe('1 listener')
    expect(eventName({ k: 'deliver', kind: 'event', name: 'x', listeners: 2 }).detail).toBe('2 listeners')
  })
})

describe('formatBytes', () => {
  it('scales units and stays empty when there is nothing to say', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(163)).toBe('163 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
