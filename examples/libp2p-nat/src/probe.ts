import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { multiaddr } from '@multiformats/multiaddr'
import { createSuperLineClient } from '@super-line/client'
import { libp2pClientTransport } from '@super-line/transport-libp2p'
import { chat } from './contract.js'
import { relayMultiaddr, serverPeerIdSet, DISCOVERY_TOPIC } from './keys.js'
import { ICE_SERVERS } from './ice.js'

// Headless stand-in for the React browser client (verifies the path without a browser):
// bootstrap to the relay → discover a SERVER via pubsub → dial it over webrtc → chat.
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1'
const SERVER_NODES = (process.env.SERVER_NODES ?? 'node-1,node-2').split(',')
const relayAddr = relayMultiaddr(RELAY_HOST)
const knownServers = await serverPeerIdSet(SERVER_NODES)

const node = await createLibp2p({
  transports: [webSockets(), webRTC({ rtcConfiguration: { iceServers: ICE_SERVERS } }), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  peerDiscovery: [pubsubPeerDiscovery({ topics: [DISCOVERY_TOPIC], interval: 5_000 })],
  services: { identify: identify(), pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }) },
})

console.log('[probe] dialing relay', relayAddr)
await node.dial(multiaddr(relayAddr), { signal: AbortSignal.timeout(10_000) })

// Discover a live SERVER (role-filtered against the known-server set; ignore relay/other clients).
console.log('[probe] waiting to discover a server via pubsub…')
const serverPeerId = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no server discovered in 30s')), 30_000)
  node.addEventListener('peer:discovery', (evt) => {
    const id = evt.detail.id.toString()
    if (!knownServers.has(id)) return
    clearTimeout(t)
    resolve(id)
  })
})
const serverAddr = `${relayAddr}/p2p-circuit/webrtc/p2p/${serverPeerId}`
console.log('[probe] discovered server → dialing over webrtc:', serverAddr)

const client = createSuperLineClient(chat, {
  transport: libp2pClientTransport({ node, multiaddr: multiaddr(serverAddr) }),
  role: 'user',
  params: { name: 'probe' },
})

const echoed = new Promise<{ text: string; node: string }>((resolve) => {
  client.on('message', (m) => resolve({ text: m.text, node: m.node }))
})

const joined = await client.join({ room: 'lobby' })
console.log('[probe] joined lobby on', joined.node, '— count', joined.count)
await client.send({ room: 'lobby', text: 'hello over webrtc-through-relay' })
const m = await echoed
console.log(`[probe] ✅ CHAT ROUND-TRIP OK: "${m.text}" (served by ${m.node})`)

client.close()
await node.stop()
process.exit(0)
