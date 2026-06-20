import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { memory } from '@libp2p/memory'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import type { Adapter } from '@super-line/core'
import { createLibp2pAdapter, type Libp2pAdapterOptions, type PubSubLibp2p } from '@super-line/adapter-libp2p'

export type { PubSubLibp2p } from '@super-line/adapter-libp2p'

// The shared topic the libp2p adapter joins (mirror of its default).
export const TOPIC = 'super-line/v1'

export type Transport = 'tcp' | 'memory'

let memSeq = 0

// A bare libp2p node with a gossipsub pubsub service, ready to back an adapter.
export async function makeNode(transport: Transport = 'memory'): Promise<PubSubLibp2p> {
  const listen = transport === 'tcp' ? ['/ip4/127.0.0.1/tcp/0'] : [`/memory/sl-test-${++memSeq}`]
  const node = await createLibp2p({
    addresses: { listen },
    transports: transport === 'tcp' ? [tcp()] : [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  })
  return node as unknown as PubSubLibp2p
}

// Slice 1 used the TCP node directly.
export const makeTcpNode = (): Promise<PubSubLibp2p> => makeNode('tcp')

// Dial every pair (full mesh) so every node directly sees every other as a topic subscriber.
export async function connectAll(nodes: PubSubLibp2p[]): Promise<void> {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      await nodes[i]!.dial(nodes[j]!.getMultiaddrs())
    }
  }
}

// Wait until every node sees at least `expected` peers subscribed to the topic.
export async function waitForSubscribers(
  nodes: PubSubLibp2p[],
  expected: number,
  topic = TOPIC,
  timeout = 8000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (nodes.every((n) => n.services.pubsub.getSubscribers(topic).length >= expected)) return
    if (Date.now() - start > timeout) throw new Error('waitForSubscribers timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

export interface Nodes {
  nodes: PubSubLibp2p[]
  dispose: () => Promise<void>
}

// Build `n` interconnected, topic-subscribed libp2p nodes, meshed and ready. Crypto-heavy
// node creation is done ONCE per file (call from beforeAll); hand out cheap per-test adapters
// with adapterOn(). Leak-safe: disposes any started nodes if setup fails under load.
export async function makeNodes(n: number, transport: Transport = 'memory'): Promise<Nodes> {
  const nodes: PubSubLibp2p[] = []
  const dispose = async (): Promise<void> => {
    for (const node of nodes) await node.stop()
  }
  try {
    for (let i = 0; i < n; i++) nodes.push(await makeNode(transport))
    for (const node of nodes) node.services.pubsub.subscribe(TOPIC) // form the mesh up front
    await connectAll(nodes)
    await waitForSubscribers(nodes, n - 1)
  } catch (err) {
    await dispose()
    throw err
  }
  return { nodes, dispose }
}

// A fresh adapter on a persistent node (cheap — no crypto, just a topic subscribe + listener).
export const adapterOn = (
  node: PubSubLibp2p,
  presence?: Libp2pAdapterOptions['presence'],
): Promise<Adapter> => createLibp2pAdapter({ node, presence })
