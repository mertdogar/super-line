import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Libp2p } from '@libp2p/interface'
import { createLibp2pAdapter, createRelayNode } from '@super-line/adapter-libp2p'
import { waitForSubscribers } from './libp2p-cluster.js'
import { waitFor } from './harness.js'

// Exercises the BUILT-IN node builder end to end for each discovery strategy — the peers actually
// find each other (bootstrap dial / real multicast / relay-brokered circuit) over loopback, no Docker.
type Pair = [string, string | Uint8Array]
type Built = Awaited<ReturnType<typeof createLibp2pAdapter>>

let seq = 0
const uniqueTopic = (): string => `sl-disco-test-${process.pid}-${++seq}`

const adapters: Built[] = []
const relays: Libp2p[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close?.()
  for (const r of relays.splice(0)) await r.stop()
  vi.restoreAllMocks()
})

const track = (a: Built): Built => {
  adapters.push(a)
  return a
}
const collect = (a: Built): Pair[] => {
  const got: Pair[] = []
  a.onMessage((c, p) => got.push([c, p]))
  return got
}

describe('libp2p adapter — discovery strategies (built node)', () => {
  it('bootstrap: node B seeds off A’s multiaddr and they fan out', async () => {
    const topic = uniqueTopic()
    const a = track(await createLibp2pAdapter({ topic, presence: false, listen: ['/ip4/127.0.0.1/tcp/0'], identity: undefined }))
    const seed = a.node.getMultiaddrs().map(String).find((m) => m.includes('/p2p/'))!
    const b = track(await createLibp2pAdapter({ topic, presence: false, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: { bootstrap: [seed] } }))

    await waitForSubscribers([a.node, b.node], 1, topic, 15_000)
    const aGot = collect(a)
    const bGot = collect(b)
    a.subscribe('r:x')
    b.subscribe('r:x')

    await waitFor(async () => {
      await a.publish('r:x', 'hi')
      return aGot.length > 0 && bGot.length > 0
    }, 15_000)
    expect(aGot[0]).toEqual(['r:x', 'hi'])
    expect(bGot[0]).toEqual(['r:x', 'hi'])
  }, 30_000)

  it('mdns: two nodes discover over multicast and fan out', async () => {
    const topic = uniqueTopic()
    const a = track(await createLibp2pAdapter({ topic, presence: false, discovery: 'mdns' }))
    const b = track(await createLibp2pAdapter({ topic, presence: false, discovery: 'mdns' }))

    await waitForSubscribers([a.node, b.node], 1, topic, 25_000)
    const bGot = collect(b)
    a.subscribe('r:x')
    b.subscribe('r:x')

    await waitFor(async () => {
      await a.publish('r:x', 'over-mcast')
      return bGot.length > 0
    }, 15_000)
    expect(bGot[0]).toEqual(['r:x', 'over-mcast'])
  }, 45_000)

  it('relay: two nodes discover each other via a circuit-relay and fan out', async () => {
    const topic = uniqueTopic()
    const relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], topic })
    relays.push(relay)
    const relayAddr = relay.getMultiaddrs().map(String).find((m) => m.includes('/ws/p2p/'))!

    // No bootstrap, no mdns: the ONLY way these two learn the other exists is the relay bridging
    // their pubsub peer-discovery. First contact rides the circuit; the data plane meshes over the
    // direct connection that discovery unlocks (DCUtR-upgraded in a real NAT).
    const a = track(await createLibp2pAdapter({ topic, presence: false, discovery: { relay: relayAddr } }))
    const b = track(await createLibp2pAdapter({ topic, presence: false, discovery: { relay: relayAddr } }))

    await waitForSubscribers([a.node, b.node], 1, topic, 30_000)
    const bGot = collect(b)
    a.subscribe('r:x')
    b.subscribe('r:x')

    await waitFor(async () => {
      await a.publish('r:x', 'via-relay')
      return bGot.length > 0
    }, 20_000)
    expect(bGot[0]).toEqual(['r:x', 'via-relay'])
  }, 60_000)
})

describe('libp2p adapter — ephemeral-identity warning', () => {
  it('warns with no discovery (likely a seed — its peer ID must be stable)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    track(await createLibp2pAdapter({ topic: uniqueTopic(), presence: false, listen: ['/ip4/127.0.0.1/tcp/0'] }))
    expect(warn).toHaveBeenCalled()
  })

  it('warns with bootstrap discovery (peer IDs live in static lists)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    track(await createLibp2pAdapter({ topic: uniqueTopic(), presence: false, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: { bootstrap: [] } }))
    expect(warn).toHaveBeenCalled()
  })

  it('stays silent with mdns-only discovery (peers re-find each other after restart)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    track(await createLibp2pAdapter({ topic: uniqueTopic(), presence: false, discovery: 'mdns' }))
    expect(warn).not.toHaveBeenCalled()
  })
})
