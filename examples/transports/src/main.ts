import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { EventSource } from 'eventsource'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { httpServerTransport, httpClientTransport } from '@super-line/transport-http'
import { libp2pServerTransport, libp2pClientTransport } from '@super-line/transport-libp2p'
import { api } from './contract.js'

const libp2pNode = (): Promise<Libp2p> =>
  createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  })

async function main() {
  // ── ONE server, THREE transports ──────────────────────────────────────────
  // WS + HTTP share a single http.Server (upgrade vs request channel); libp2p uses its own node.
  const httpServer = http.createServer()
  const serverNode = await libp2pNode()
  const srv = createSuperLineServer(api, {
    transports: [
      webSocketServerTransport({ server: httpServer }),
      httpServerTransport({ server: httpServer }),
      libp2pServerTransport({ node: serverNode }),
    ],
    // the wire each connection arrived on, surfaced from the handshake into ctx
    authenticate: (h) => ({ role: 'user' as const, ctx: { via: h.transport } }),
  })
  srv.implement({
    user: {
      echo: async ({ text }, ctx) => ({ text, via: (ctx as { via: string }).via }),
    },
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as AddressInfo
  const origin = (proto: string) => `${proto}://127.0.0.1:${port}`

  // ── THREE clients — the ONLY difference is the transport line ───────────────
  const clientNode = await libp2pNode()
  const clients: Array<[string, SuperLineClient<typeof api, 'user'>]> = [
    ['websocket', createSuperLineClient(api, { transport: webSocketClientTransport({ url: origin('ws') }), role: 'user' })],
    ['http/sse', createSuperLineClient(api, { transport: httpClientTransport({ url: origin('http'), EventSource }), role: 'user' })],
    ['libp2p', createSuperLineClient(api, { transport: libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }), role: 'user' })],
  ]

  // The SAME call on every wire — identical request, identical result shape.
  console.log('— same contract, every wire —')
  for (const [name, client] of clients) {
    const out = await client.echo({ text: 'hello' })
    console.log(`  client over ${name.padEnd(10)} →  "${out.text}"  (server received it via "${out.via}")`)
  }

  // A server event reaches every wire identically too.
  for (const [name, client] of clients) client.on('announce', (a) => console.log(`  [${name}] announce: ${a.msg}`))
  console.log('\n— one server push, fanned to every wire —')
  for (const conn of srv.local.connections) conn.emit('announce', { msg: 'broadcast to all wires' })
  await new Promise((r) => setTimeout(r, 200))

  // ── teardown ────────────────────────────────────────────────────────────────
  for (const [, client] of clients) client.close()
  await srv.close()
  await new Promise<void>((r) => httpServer.close(() => r()))
  await clientNode.stop()
  await serverNode.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
