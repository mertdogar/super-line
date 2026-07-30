import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnDescriptor } from '@super-line/core'

// Restart timing + real sockets under parallel-suite contention — give it headroom.
vi.setConfig({ testTimeout: 30_000 })
import { createZeroMqAdapter, type ZeroMqAdapter } from '../src/index.js'
import { waitForWith } from '../../core/test/wait.js'

const waitUntil = waitForWith(20_000)

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SETTLE = 250

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })

const desc = (id: string, nodeId: string): ConnDescriptor => ({
  id,
  role: 'user',
  nodeId,
  nodeName: nodeId,
  connectedAt: 0,
  rooms: [],
})

describe('zeromq mesh — operational stability', () => {
  const open: ZeroMqAdapter[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close?.()))
  })

  it('resumes fan-out and re-learns presence after a peer restarts', async () => {
    const portB = await freePort()
    const urlB = `tcp://127.0.0.1:${portB}`
    const a = await createZeroMqAdapter({ bind: 'tcp://127.0.0.1:0', peers: [urlB], presence: { snapshotIntervalMs: 150, livenessTtlMs: 800 } })
    open.push(a)
    let b = await createZeroMqAdapter({ bind: urlB, peers: [a.endpoint], presence: { snapshotIntervalMs: 150, livenessTtlMs: 800 } })
    open.push(b)

    const got: string[] = []
    a.onMessage((_ch, p) => got.push(Buffer.from(p).toString()))
    a.subscribe('room')
    b.presence!.beat('B')
    await b.presence!.set(desc('c1', 'B'))
    await delay(SETTLE)

    await b.publish('room', 'before')
    await waitUntil(() => got.includes('before'))
    await waitUntil(async () => (await a.presence!.list()).some((d) => d.id === 'c1'))

    await b.close?.() // B "crashes" — its PUB on portB goes away
    await delay(SETTLE)

    // B restarts on the SAME port; a's SUB auto-reconnects and re-sends its subscription
    b = await createZeroMqAdapter({ bind: urlB, peers: [a.endpoint], presence: { snapshotIntervalMs: 150, livenessTtlMs: 800 } })
    open.push(b)
    b.presence!.beat('B')
    await b.presence!.set(desc('c2', 'B'))

    await waitUntil(async () => {
      await b.publish('room', 'after')
      return got.includes('after')
    }, { timeout: 10_000, label: 'fan-out resumes after the peer restarts' })
    expect(got).toContain('after') // fan-out resumed across the restart
    await waitUntil(async () => (await a.presence!.list()).some((d) => d.id === 'c2')) // presence self-healed
  })
})
