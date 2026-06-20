import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter } from '@super-line/core'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { connectStar, makeTcpNode, waitForSubscribers } from './libp2p-cluster.js'
import { waitFor } from './harness.js'

// Real-TCP fidelity suite: spins up libp2p nodes over loopback (no Docker).
type Pair = [string, string | Uint8Array]

const adapters: Adapter[] = []
const nodes: Awaited<ReturnType<typeof makeTcpNode>>[] = []

afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close?.()
  for (const n of nodes.splice(0)) await n.stop()
})

async function adapterOn(node: Awaited<ReturnType<typeof makeTcpNode>>): Promise<Adapter> {
  const a = await createLibp2pAdapter({ node })
  adapters.push(a)
  return a
}

describe('libp2p adapter — core fan-out (real TCP)', () => {
  it('loops a publish back to the publisher’s own subscribed channels (emitSelf)', async () => {
    const node = await makeTcpNode()
    nodes.push(node)
    const a = await adapterOn(node)
    const got: Pair[] = []
    a.onMessage((c, p) => got.push([c, p]))
    a.subscribe('r:x')

    // solo node: emitSelf delivers our own publish back to our handler
    await waitFor(async () => {
      await a.publish('r:x', 'hello')
      return got.length > 0
    }, 8000)
    expect(got[0]).toEqual(['r:x', 'hello'])
  })

  it('does not deliver channels the node is not subscribed to', async () => {
    const node = await makeTcpNode()
    nodes.push(node)
    const a = await adapterOn(node)
    const got: Pair[] = []
    a.onMessage((c, p) => got.push([c, p]))
    a.subscribe('r:x') // NOT subscribed to c:other

    await a.publish('c:other', 'nope')
    await waitFor(async () => {
      await a.publish('r:x', 'yep')
      return got.length > 0
    }, 8000)
    expect(got.every(([c]) => c === 'r:x')).toBe(true)
  })

  it('preserves binary payloads across the wire', async () => {
    const node = await makeTcpNode()
    nodes.push(node)
    const a = await adapterOn(node)
    const got: Pair[] = []
    a.onMessage((c, p) => got.push([c, p]))
    a.subscribe('r:bin')

    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    await waitFor(async () => {
      await a.publish('r:bin', bytes)
      return got.length > 0
    }, 8000)
    const [, payload] = got[0]!
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(Array.from(payload as Uint8Array)).toEqual([0, 1, 2, 255, 254])
  })

  it('delivers across two connected nodes and loops back to the publisher', async () => {
    const na = await makeTcpNode()
    const nb = await makeTcpNode()
    nodes.push(na, nb)
    const a = await adapterOn(na)
    const b = await adapterOn(nb)
    await connectStar([na, nb])
    await waitForSubscribers([na, nb], 1)

    const aGot: Pair[] = []
    const bGot: Pair[] = []
    a.onMessage((c, p) => aGot.push([c, p]))
    b.onMessage((c, p) => bGot.push([c, p]))
    a.subscribe('r:x')
    b.subscribe('r:x')

    await waitFor(async () => {
      await a.publish('r:x', 'hi')
      return aGot.length > 0 && bGot.length > 0
    }, 8000)
    expect(aGot[0]).toEqual(['r:x', 'hi'])
    expect(bGot[0]).toEqual(['r:x', 'hi'])
  })

  it('routes a targeted channel only to the subscribed node', async () => {
    const na = await makeTcpNode()
    const nb = await makeTcpNode()
    nodes.push(na, nb)
    const a = await adapterOn(na)
    const b = await adapterOn(nb)
    await connectStar([na, nb])
    await waitForSubscribers([na, nb], 1)

    const aGot: Pair[] = []
    const bGot: Pair[] = []
    a.onMessage((c, p) => aGot.push([c, p]))
    b.onMessage((c, p) => bGot.push([c, p]))
    b.subscribe('c:conn1') // only B holds this connection
    a.subscribe('sync')
    b.subscribe('sync')

    await waitFor(async () => {
      await a.publish('c:conn1', 'to-b') // A is NOT subscribed to c:conn1
      await a.publish('sync', 's')
      return bGot.some(([c]) => c === 'c:conn1') && bGot.some(([c]) => c === 'sync')
    }, 8000)

    expect(bGot.some(([c, p]) => c === 'c:conn1' && p === 'to-b')).toBe(true)
    expect(aGot.some(([c]) => c === 'c:conn1')).toBe(false) // A filtered it (not subscribed)
  })
})
