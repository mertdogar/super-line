import http from 'node:http'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { dcutr } from '@libp2p/dcutr'
import { gossipsub } from '@libp2p/gossipsub'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { multiaddr } from '@multiformats/multiaddr'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import { createLibp2pAdapter, type PubSubLibp2p } from '@super-line/adapter-libp2p'
import { chat } from './contract.js'
import { keyFor, relayMultiaddr, serverPeerIdSet, DISCOVERY_TOPIC } from './keys.js'

// One chat node "behind NAT": its libp2p node advertises ONLY /p2p-circuit + /webrtc — no directly
// dialable address — so discovery, signaling, and first contact are all forced through the relay.
// The SAME node feeds two super-line layers: the libp2p server transport (browser↔server, webrtc)
// and the libp2p adapter (server↔server gossipsub fan-out). No super-line code changes.
const NODE = process.env.NODE_NAME ?? 'node-1'
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1'
const SERVER_NODES = (process.env.SERVER_NODES ?? 'node-1,node-2').split(',')
const INSPECTOR_PORT = Number(process.env.INSPECTOR_PORT ?? 0) // set on one node for the Control Center
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const relayAddr = relayMultiaddr(RELAY_HOST)
const knownServers = await serverPeerIdSet(SERVER_NODES) // role-filter: only mesh-dial other servers

const node = (await createLibp2p({
  privateKey: await keyFor(NODE), // stable identity → stable node name in the Control Center
  addresses: { listen: ['/p2p-circuit', '/webrtc'] },
  transports: [webSockets(), webRTC(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  peerDiscovery: [pubsubPeerDiscovery({ topics: [DISCOVERY_TOPIC], interval: 5_000 })],
  services: {
    identify: identify(),
    dcutr: dcutr(), // upgrade relayed server↔server links to direct where the network allows
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
  },
})) as unknown as PubSubLibp2p

console.log(`[${NODE}] peerId ${node.peerId.toString()}`)
console.log(`[${NODE}] dialing relay ${relayAddr}`)
for (let i = 1; ; i++) {
  try {
    await node.dial(multiaddr(relayAddr), { signal: AbortSignal.timeout(5_000) })
    break
  } catch (e) {
    if (i >= 15) throw e
    console.log(`[${NODE}] relay dial retry ${i}…`)
    await delay(1_000)
  }
}

// Dial discovered *servers* (role-filtered) so the gossipsub mesh forms for the adapter's fan-out.
// Browsers also broadcast on the topic; we ignore them — they connect to us, not the other way round.
node.addEventListener('peer:discovery', (evt) => {
  const id = evt.detail.id.toString()
  if (id === node.peerId.toString() || !knownServers.has(id)) return
  void node.dial(evt.detail.multiaddrs).then(
    () => console.log(`[${NODE}] connected to peer ${id.slice(-8)} (cluster mesh)`),
    () => {},
  )
})

// Wait until the relay reservation has minted our /webrtc address (then browsers can dial us).
for (let i = 0; i < 40 && !node.getMultiaddrs().some((m) => m.toString().includes('/webrtc')); i++) await delay(500)
console.log(`[${NODE}] reachable via`, node.getMultiaddrs().map(String).find((m) => m.includes('/webrtc')))

const transports: Parameters<typeof createSuperLineServer>[1]['transports'] = [libp2pServerTransport({ node })]
let inspectorHttp: http.Server | undefined
if (INSPECTOR_PORT) {
  // Out-of-band management port for the Control Center (WS inspector). NOT how app clients connect —
  // they use libp2p/webrtc. Inspector telemetry is cluster-wide, so one gateway shows every node.
  inspectorHttp = http.createServer()
  transports.push(webSocketServerTransport({ server: inspectorHttp, inspector: true }))
}

const roomOf = new Map<Conn, string>()
let seq = 0

const srv = createSuperLineServer(chat, {
  transports,
  adapter: await createLibp2pAdapter({ node }), // reuse the SAME node for server↔server fan-out
  nodeName: NODE,
  inspector: true,
  identify: (conn) => (conn.ctx as { name: string }).name,
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  onDisconnect: (conn) => {
    const room = roomOf.get(conn)
    if (!room) return
    roomOf.delete(conn)
    void publishPresence(room, conn.id, 'leave')
  },
})

const publishPresence = async (room: string, connId: string, change: 'join' | 'leave'): Promise<number> => {
  const ids = new Set((await srv.cluster.room(room)).map((c) => c.id))
  if (change === 'join') ids.add(connId)
  else ids.delete(connId)
  srv.forRole('user').publish('presence', { room, count: ids.size })
  return ids.size
}

srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      roomOf.set(conn, room)
      const count = await publishPresence(room, conn.id, 'join')
      return { ok: true, count, node: NODE }
    },
    send: async ({ room, text }, ctx) => {
      seq += 1
      const id = `${NODE}_${seq}`
      srv.room(room).broadcast('message', { room, id, text, from: ctx.name, node: NODE, at: Date.now() })
      return { id }
    },
  },
})

if (inspectorHttp) inspectorHttp.listen(INSPECTOR_PORT, () => console.log(`[${NODE}] Control Center inspector → :${INSPECTOR_PORT}`))
console.log(`[${NODE}] chat server up (behind NAT) — waiting for clients…`)
