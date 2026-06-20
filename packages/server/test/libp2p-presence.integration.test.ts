import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter, ConnDescriptor } from '@super-line/core'
import { adapterOn, makeNodes, type Nodes } from './libp2p-cluster.js'
import { waitFor } from './harness.js'

// Presence replication across real libp2p adapters (memory transport). Fresh nodes per test
// for clean replicas. Reconcile edge cases are unit-tested in adapter-libp2p/test.
let cluster: Nodes | undefined
const adapters: Adapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close?.()
  await cluster?.dispose()
  cluster = undefined
})

const desc = (id: string, nodeId: string, over: Partial<ConnDescriptor> = {}): ConnDescriptor => ({
  id,
  role: 'user',
  nodeId,
  nodeName: nodeId,
  connectedAt: 0,
  rooms: [],
  ...over,
})

describe('libp2p adapter — presence convergence (memory transport)', () => {
  it('replicates each node’s descriptors to every node', async () => {
    cluster = await makeNodes(3)
    for (const n of cluster.nodes) adapters.push(await adapterOn(n))
    adapters[0]!.presence!.set(desc('c0', 'node-0', { userId: 'u0' }))
    adapters[1]!.presence!.set(desc('c1', 'node-1', { userId: 'u1', rooms: ['lobby'] }))
    adapters[2]!.presence!.set(desc('c2', 'node-2'))

    for (const a of adapters) await waitFor(async () => (await a.presence!.list()).length === 3, 8000)
    for (const a of adapters) {
      expect(await a.presence!.count()).toBe(3)
      expect((await a.presence!.byUser('u1')).map((d) => d.id)).toEqual(['c1'])
      expect((await a.presence!.roomMembers('lobby')).map((d) => d.id)).toEqual(['c1'])
      expect((await a.presence!.topology()).length).toBe(3)
    }
  })

  it('propagates a delta (addRoom) to other nodes', async () => {
    cluster = await makeNodes(2)
    for (const n of cluster.nodes) adapters.push(await adapterOn(n))
    adapters[0]!.presence!.set(desc('c0', 'node-0'))
    await waitFor(async () => (await adapters[1]!.presence!.count()) === 1, 8000)

    adapters[0]!.presence!.addRoom('c0', 'room1')
    await waitFor(async () => (await adapters[1]!.presence!.roomMembers('room1')).length === 1, 8000)
    expect((await adapters[1]!.presence!.get('c0'))!.rooms).toEqual(['room1'])
  })
})
