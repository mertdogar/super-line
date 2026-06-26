import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { gossipsub } from '@libp2p/gossipsub'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { relayKey, RELAY_PORT, DISCOVERY_TOPIC } from './keys.js'

// The one public node. It does three jobs at once, all on a single WebSocket-reachable libp2p node:
//  1. circuit-relay-v2 server   → NAT'd servers reserve a slot and become dialable via /p2p-circuit
//  2. gossipsub router          → bridges the pubsub-discovery topic between everyone connected to it
//  3. (listenOnly discovery)    → subscribes to the discovery topic so it forwards, without
//                                 advertising itself as a discoverable peer
const relay = await createLibp2p({
  privateKey: relayKey,
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${RELAY_PORT}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  peerDiscovery: [pubsubPeerDiscovery({ topics: [DISCOVERY_TOPIC], listenOnly: true })],
  services: {
    identify: identify(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    relay: circuitRelayServer({ reservations: { maxReservations: 128 } }),
  },
})

console.log('[relay] up. dialable at:')
for (const ma of relay.getMultiaddrs()) console.log('  ' + ma.toString())
