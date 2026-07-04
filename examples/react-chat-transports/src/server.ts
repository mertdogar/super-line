import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { httpServerTransport } from '@super-line/transport-http'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import { chat } from './contract.js'

// ONE server, THREE client↔server transports: WebSocket + HTTP share the http.Server; libp2p
// rides a started libp2p node. The browser's transport dial picks which wire to dial.
const PORT = Number(process.env.PORT ?? 8787) // WS + HTTP (one http.Server)
const P2P_PORT = Number(process.env.P2P_PORT ?? 9101) // libp2p /ws listener (browser dials this directly)
const NODE = process.env.NODE_NAME ?? 'node-1'

// A stable, seed-derived PeerId so the browser can dial a known multiaddr it fetches from /libp2p-addr.
const seed = new Uint8Array(32)
new TextEncoder().encodeInto(NODE.padEnd(8, '·'), seed)
const privateKey = await generateKeyPairFromSeed('Ed25519', seed)

const node = await createLibp2p({
  privateKey,
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
})

const server = http.createServer()
const roomOf = new Map<Conn, string>()
let seq = 0

// Tiny non-super-line endpoint: hand the browser the libp2p dial port + stable PeerId.
// Registered before createSuperLineServer adds its own 'request' listener; we only touch our path.
server.on('request', (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/libp2p-addr') return
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify({ port: P2P_PORT, peerId: node.peerId.toString() }))
})

const srv = createSuperLineServer(chat, {
  transports: [
    webSocketServerTransport({ server }),
    httpServerTransport({ server }), // basePath defaults to /superline
    libp2pServerTransport({ node }), // protocol /super-line/1.0.0 on the started node
  ],
  nodeName: NODE,
  plugins: [inspector()],
  identify: (c) => (c.ctx as { name: string }).name,
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name, via: h.transport } } // surface the wire into ctx
  },
  onDisconnect: (c) => {
    const room = roomOf.get(c)
    if (room) {
      roomOf.delete(c)
      bump(room)
    }
  },
})

const bump = (room: string) => srv.forRole('user').publish('presence', { room, count: srv.room(room).size })

srv.implement({
  user: {
    join: async ({ room }, ctx, conn) => {
      srv.room(room).add(conn)
      roomOf.set(conn, room)
      bump(room)
      return { ok: true, count: srv.room(room).size, via: (ctx as { via: string }).via }
    },
    send: async ({ room, text }, ctx) => {
      seq += 1
      const id = `${NODE}_${seq}`
      srv.room(room).broadcast('message', {
        room,
        id,
        text,
        from: (ctx as { name: string }).name,
        via: (ctx as { via: string }).via,
        at: Date.now(),
      })
      return { id }
    },
  },
})

server.listen(PORT, () => {
  const { port } = server.address() as AddressInfo
  console.log(`[${NODE}] up on :${port} (WS + HTTP) · libp2p /ws :${P2P_PORT} · peer ${node.peerId.toString()}`)
})
