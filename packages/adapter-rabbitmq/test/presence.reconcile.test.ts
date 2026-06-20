import { afterEach, describe, expect, it } from 'vitest'
import type { ConnDescriptor } from '@super-line/core'
import { GossipPresence, type PresenceMsg } from '../src/presence.js'

const desc = (id: string, nodeId: string, over: Partial<ConnDescriptor> = {}): ConnDescriptor => ({
  id,
  role: 'user',
  nodeId,
  nodeName: nodeId,
  connectedAt: 0,
  rooms: [],
  ...over,
})

const instances: GossipPresence[] = []
function make() {
  const sent: PresenceMsg[] = []
  // huge interval/ttl: no auto-snapshot, no pruning — drive reconcile deterministically
  const p = new GossipPresence((m) => sent.push(m), { snapshotIntervalMs: 1e9, livenessTtlMs: 1e9 })
  instances.push(p)
  return { p, sent }
}
afterEach(() => {
  for (const p of instances.splice(0)) p.stop()
})

describe('GossipPresence reconcile', () => {
  it('records a local write and broadcasts a delta', () => {
    const { p, sent } = make()
    p.set(desc('c1', 'A'))
    expect(p.list().map((d) => d.id)).toEqual(['c1'])
    expect(sent).toEqual([{ t: 'd', n: 'A', q: 1, op: { k: 'set', d: desc('c1', 'A') } }])
  })

  it('reconciles another node’s deltas into the replica', () => {
    const { p } = make()
    p.set(desc('a1', 'A'))
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('b1', 'B') } })
    expect(p.list().map((d) => d.id).sort()).toEqual(['a1', 'b1'])
  })

  it('ignores our own echoed messages', () => {
    const { p } = make()
    p.set(desc('a1', 'A')) // selfNodeId = A
    p.receive({ t: 's', n: 'A', q: 0, ts: 0, c: [] }) // echo with stale/empty content
    expect(p.list().map((d) => d.id)).toEqual(['a1'])
  })

  it('does not let a stale snapshot clobber a newer delta (monotonic seq)', () => {
    const { p } = make()
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('c1', 'B') } })
    p.receive({ t: 'd', n: 'B', q: 2, op: { k: 'addRoom', id: 'c1', room: 'x' } })
    expect(p.roomMembers('x').map((d) => d.id)).toEqual(['c1'])
    p.receive({ t: 's', n: 'B', q: 1, ts: 0, c: [desc('c1', 'B')] }) // stale (no room)
    expect(p.roomMembers('x').map((d) => d.id)).toEqual(['c1']) // unchanged
  })

  it('heals a dropped delta at the next snapshot', () => {
    const { p } = make()
    p.receive({ t: 'd', n: 'B', q: 2, op: { k: 'addRoom', id: 'c1', room: 'x' } }) // missed the set (q1)
    expect(p.list()).toHaveLength(0) // addRoom on a conn we don't have is a no-op
    p.receive({ t: 's', n: 'B', q: 2, ts: 0, c: [desc('c1', 'B', { rooms: ['x'] })] })
    expect(p.roomMembers('x').map((d) => d.id)).toEqual(['c1']) // healed
  })

  it('ignores duplicate / out-of-order deltas (idempotent)', () => {
    const { p } = make()
    const d1: PresenceMsg = { t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('c1', 'B') } }
    p.receive(d1)
    p.receive(d1)
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'del', id: 'c1' } }) // stale seq, ignored
    expect(p.count()).toBe(1)
  })

  it('applies del and drops the whole slice on leave', () => {
    const { p } = make()
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('c1', 'B') } })
    p.receive({ t: 'd', n: 'B', q: 2, op: { k: 'set', d: desc('c2', 'B') } })
    p.receive({ t: 'd', n: 'B', q: 3, op: { k: 'del', id: 'c1' } })
    expect(p.list().map((d) => d.id)).toEqual(['c2'])
    p.receive({ t: 'l', n: 'B' })
    expect(p.count()).toBe(0)
  })

  it('answers byUser and topology across nodes', () => {
    const { p } = make()
    p.set(desc('a1', 'A', { userId: 'u1' }))
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('b1', 'B', { userId: 'u1', rooms: ['r'] }) } })
    expect(p.byUser('u1').map((d) => d.id).sort()).toEqual(['a1', 'b1'])
    const topo = p.topology().sort((x, y) => x.nodeId.localeCompare(y.nodeId))
    expect(topo).toEqual([
      { nodeId: 'A', nodeName: 'A', connections: 1, rooms: 0, alive: true },
      { nodeId: 'B', nodeName: 'B', connections: 1, rooms: 1, alive: true },
    ])
  })

  it('resnapshot re-advertises the self slice on demand', () => {
    const { p, sent } = make()
    p.set(desc('a1', 'A')) // delta q1
    sent.length = 0
    p.resnapshot()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 's', n: 'A', q: 1 })
    expect((sent[0] as Extract<PresenceMsg, { t: 's' }>).c.map((d) => d.id)).toEqual(['a1'])
  })

  it('resnapshot is a no-op for an idle node with no connections', () => {
    const { p, sent } = make()
    p.resnapshot()
    expect(sent).toEqual([])
  })
})

describe('GossipPresence liveness', () => {
  it('excludes a node not heard from within the TTL', () => {
    let t = 1000
    const p = new GossipPresence(() => {}, { snapshotIntervalMs: 1e9, livenessTtlMs: 1000, now: () => t })
    instances.push(p)
    p.set(desc('a1', 'A')) // self — never pruned
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('b1', 'B') } }) // B seen at t=1000
    expect(p.count()).toBe(2)

    t = 2500 // 1500ms since B was last heard from > ttl
    expect(p.list().map((d) => d.id)).toEqual(['a1'])
  })

  it('keeps a node alive when heard from again before the TTL', () => {
    let t = 1000
    const p = new GossipPresence(() => {}, { snapshotIntervalMs: 1e9, livenessTtlMs: 1000, now: () => t })
    instances.push(p)
    p.set(desc('a1', 'A'))
    p.receive({ t: 'd', n: 'B', q: 1, op: { k: 'set', d: desc('b1', 'B') } }) // t=1000
    t = 1800
    p.receive({ t: 's', n: 'B', q: 1, ts: 0, c: [desc('b1', 'B')] }) // refresh at t=1800
    t = 2500 // only 700ms since last B message < ttl
    expect(p.count()).toBe(2)
  })
})
