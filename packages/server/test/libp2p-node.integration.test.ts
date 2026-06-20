import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { makeTcpNode, type PubSubLibp2p } from './libp2p-cluster.js'
import { tick } from './harness.js'

type Pair = [string, string | Uint8Array]
const TCP = '/ip4/127.0.0.1/tcp/0'

const adapters: Array<{ close?: () => unknown }> = []
const nodes: PubSubLibp2p[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close?.()
  for (const n of nodes.splice(0)) await n.stop()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'sl-p2p-'))
  dirs.push(d)
  return d
}

// Solo loopback proves explicit-loopback delivery without peers.
async function expectLoopback(adapter: Awaited<ReturnType<typeof createLibp2pAdapter>>) {
  const got: Pair[] = []
  adapter.onMessage((c, p) => got.push([c, p]))
  adapter.subscribe('r:x')
  await adapter.publish('r:x', 'hi')
  await tick(150)
  expect(got).toEqual([['r:x', 'hi']])
}

describe('libp2p adapter — node ownership & config', () => {
  it('uses a bring-your-own node and does NOT stop it on close', async () => {
    const node = await makeTcpNode()
    nodes.push(node)
    const a = await createLibp2pAdapter({ node })
    expect(a.node).toBe(node)
    await a.close?.()
    expect(node.status).toBe('started') // BYO lifecycle is the caller's
  })

  it('throws a clear error if the node has no pubsub service', async () => {
    const bad = await createLibp2p({
      addresses: { listen: [TCP] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
    })
    await expect(createLibp2pAdapter({ node: bad as unknown as PubSubLibp2p })).rejects.toThrow(/pubsub/i)
    await bad.stop()
  })

  it('delivers exactly once even when the BYO node has emitSelf:true', async () => {
    const node = (await createLibp2p({
      addresses: { listen: [TCP] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), pubsub: gossipsub({ emitSelf: true, allowPublishToZeroTopicPeers: true }) },
    })) as unknown as PubSubLibp2p
    nodes.push(node)
    const a = await createLibp2pAdapter({ node })
    const got: Pair[] = []
    a.onMessage((c, p) => got.push([c, p]))
    a.subscribe('r:x')
    await a.publish('r:x', 'once')
    await tick(300) // any self-echo would have arrived by now
    expect(got).toEqual([['r:x', 'once']]) // explicit loopback once; gossipsub echo skipped
    await a.close?.()
  })

  it('builds a TCP node and loops back (built-node path)', async () => {
    const a = await createLibp2pAdapter({ listen: [TCP], identity: { path: await tmp() } })
    adapters.push(a)
    await expectLoopback(a)
  })

  it('supports the WebSocket transport', async () => {
    const a = await createLibp2pAdapter({ transport: 'ws', listen: ['/ip4/127.0.0.1/tcp/0/ws'], identity: { path: await tmp() } })
    adapters.push(a)
    expect(a.node.getMultiaddrs().some((m) => m.toString().includes('/ws'))).toBe(true)
    await expectLoopback(a)
  })

  it('persists identity via path — stable peer ID across restarts', async () => {
    const dir = await tmp()
    const a1 = await createLibp2pAdapter({ listen: [TCP], identity: { path: dir } })
    const peer1 = a1.node.peerId.toString()
    await a1.close?.()
    const a2 = await createLibp2pAdapter({ listen: [TCP], identity: { path: dir } })
    const peer2 = a2.node.peerId.toString()
    await a2.close?.()
    expect(peer1).toBe(peer2)
  })

  it('accepts a raw private key (drives the peer ID deterministically)', async () => {
    const key = await generateKeyPair('Ed25519')
    const a = await createLibp2pAdapter({ listen: [TCP], identity: key })
    const b = await createLibp2pAdapter({ listen: [TCP], identity: key })
    adapters.push(a, b)
    expect(a.node.peerId.toString()).toBe(b.node.peerId.toString())
  })

  it('warns and uses an ephemeral identity when none is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a1 = await createLibp2pAdapter({ listen: [TCP] })
    const a2 = await createLibp2pAdapter({ listen: [TCP] })
    adapters.push(a1, a2)
    expect(warn).toHaveBeenCalled()
    expect(a1.node.peerId.toString()).not.toBe(a2.node.peerId.toString())
  })
})
