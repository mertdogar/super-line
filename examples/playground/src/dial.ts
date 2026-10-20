import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { multiaddr } from '@multiformats/multiaddr'
import type { ClientTransport } from '@super-line/core'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { httpClientTransport } from '@super-line/transport-http'
import { libp2pClientTransport } from '@super-line/transport-libp2p'

// This tab's dial, from the URL: `?node=` pins a node (Caddy strips the `/node-N` prefix and routes to it;
// unpinned round-robins), `?transport=` picks the wire. Pinning matters because every tab opens two
// connections (guest, then signed in), so plain round-robin tends to put every signed-in tab on one node.
export const NODES = ['node-1', 'node-2'] as const
export const TRANSPORTS = { websocket: 'WebSocket', http: 'HTTP (SSE)', libp2p: 'libp2p' } as const
export type TransportKind = keyof typeof TRANSPORTS

const params = new URLSearchParams(location.search)
export const pinned = NODES.find((n) => n === params.get('node')) ?? null
export const kind: TransportKind = (Object.keys(TRANSPORTS) as TransportKind[]).find((k) => k === params.get('transport')) ?? 'websocket'

/** Reload onto another node or wire. The token is in sessionStorage, so the tab stays signed in. */
export function dial(next: { node?: string | null; transport?: TransportKind }): void {
  const url = new URL(location.href)
  if (next.node !== undefined) {
    if (next.node) url.searchParams.set('node', next.node)
    else url.searchParams.delete('node')
  }
  if (next.transport) url.searchParams.set('transport', next.transport)
  location.assign(url)
}

const base = `${location.host}${pinned ? `/${pinned}` : ''}`
const httpBase = `${location.protocol}//${base}`

// The node that answers /libp2p-addr hands back ITS port and PeerId, and the browser dials that node directly
// (its published port, not through Caddy). Unpinned, Caddy round-robins the lookup, which picks the node.
async function libp2pTransport(): Promise<ClientTransport> {
  const [node, { port, peerId }] = await Promise.all([
    createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: { denyDialMultiaddr: () => false }, // allow the localhost dial
      services: { identify: identify() },
    }),
    fetch(`${httpBase}/libp2p-addr`).then((r) => r.json() as Promise<{ port: number; peerId: string }>),
  ])
  return libp2pClientTransport({ node, multiaddr: multiaddr(`/dns4/${location.hostname}/tcp/${port}/ws/p2p/${peerId}`) })
}

async function transportFor(k: TransportKind): Promise<ClientTransport> {
  if (k === 'http') return httpClientTransport({ url: httpBase })
  if (k === 'libp2p') return libp2pTransport()
  return webSocketClientTransport({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${base}/ws` })
}

/**
 * ONE transport for the tab, shared by the guest client and the signed-in one. Top-level await because libp2p
 * needs a started node and a fetched address before the auth provider connects; ESM settles it before main.tsx runs.
 */
export const transport: ClientTransport = await transportFor(kind)
