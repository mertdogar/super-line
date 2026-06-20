import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import type { PubSubLibp2p } from '@super-line/adapter-libp2p'

// The shared topic the libp2p adapter joins (mirror of its default).
export const TOPIC = 'super-line/v1'

// A bare libp2p node (TCP) with a gossipsub pubsub service, ready to back an adapter.
export async function makeTcpNode(): Promise<PubSubLibp2p> {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ emitSelf: true, allowPublishToZeroTopicPeers: true }),
    },
  })
  return node as unknown as PubSubLibp2p
}

// Dial every node to the first, enough for gossip to propagate across the set.
export async function connectStar(nodes: PubSubLibp2p[]): Promise<void> {
  const [hub, ...rest] = nodes
  if (!hub) return
  for (const n of rest) await n.dial(hub.getMultiaddrs())
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
