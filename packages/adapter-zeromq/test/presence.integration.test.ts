import { afterEach, describe, expect, it } from 'vitest'
import type { ConnDescriptor } from '@super-line/core'
import { createZeroMqAdapter, type ZeroMqAdapter } from '../src/index.js'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SETTLE = 200

const desc = (id: string, nodeId: string, over: Partial<ConnDescriptor> = {}): ConnDescriptor => ({
  id,
  role: 'user',
  nodeId,
  nodeName: nodeId,
  connectedAt: 0,
  rooms: [],
  ...over,
})

describe('zeromq presence gossip (cross-node)', () => {
  const open: ZeroMqAdapter[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close?.()))
  })

  it('gossips a connection descriptor to a peer', async () => {
    const a = await createZeroMqAdapter({ bind: 'tcp://127.0.0.1:0' })
    const b = await createZeroMqAdapter({ bind: 'tcp://127.0.0.1:0', peers: [a.endpoint] })
    open.push(a, b)
    await delay(SETTLE) // let b's SUB subscribe to the presence channel on a

    a.presence!.beat('A')
    await a.presence!.set(desc('c1', 'A', { userId: 'u1', rooms: ['lobby'] }))
    await delay(SETTLE)

    const seen = await b.presence!.list()
    expect(seen.map((d) => d.id)).toEqual(['c1'])
    expect((await b.presence!.byUser('u1')).map((d) => d.id)).toEqual(['c1'])
    expect((await b.presence!.roomMembers('lobby')).map((d) => d.id)).toEqual(['c1'])
    expect((await b.presence!.topology()).find((n) => n.nodeId === 'A')?.connections).toBe(1)
  })

  it('disables presence when presence:false (no directory)', async () => {
    const a = await createZeroMqAdapter({ bind: 'tcp://127.0.0.1:0', presence: false })
    open.push(a)
    expect(a.presence).toBeUndefined()
  })
})
