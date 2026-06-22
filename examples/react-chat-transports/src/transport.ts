import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { multiaddr } from '@multiformats/multiaddr'
import type { ClientTransport } from '@super-line/core'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { httpClientTransport } from '@super-line/transport-http'
import { libp2pClientTransport } from '@super-line/transport-libp2p'

// The transport dial. Each position builds a different ClientTransport — the ONLY thing that
// differs between wires. Everything above (contract, handlers, hooks, UI) is identical.
export type TransportKind = 'websocket' | 'http' | 'libp2p'

export const TRANSPORT_LABELS: Record<TransportKind, string> = {
  websocket: 'WebSocket',
  http: 'HTTP (SSE)',
  libp2p: 'libp2p',
}

const host = location.host
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`
const httpUrl = `${location.protocol}//${host}` // origin; httpClientTransport basePath defaults to /superline

// A browser libp2p node, created once and reused for every libp2p client (a switch opens a fresh
// stream on the shared node, not a new node).
let browserNode: Libp2p | undefined
async function getBrowserNode(): Promise<Libp2p> {
  if (!browserNode) {
    browserNode = await createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: { denyDialMultiaddr: () => false }, // allow the localhost dev dial
      services: { identify: identify() },
      // no addresses.listen — the browser only dials
    })
  }
  return browserNode
}

// The server hands us its libp2p port + stable PeerId; the browser dials it directly (published port).
async function serverMultiaddr() {
  const res = await fetch(`${httpUrl}/libp2p-addr`)
  const { port, peerId } = (await res.json()) as { port: number; peerId: string }
  return multiaddr(`/dns4/${location.hostname}/tcp/${port}/ws/p2p/${peerId}`)
}

export async function transportFor(kind: TransportKind): Promise<ClientTransport> {
  if (kind === 'websocket') return webSocketClientTransport({ url: wsUrl })
  if (kind === 'http') return httpClientTransport({ url: httpUrl }) // EventSource + fetch are browser globals
  const [node, addr] = await Promise.all([getBrowserNode(), serverMultiaddr()])
  return libp2pClientTransport({ node, multiaddr: addr })
}
