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

// The transport dial. Each position builds a different ClientTransport — the ONLY thing that differs
// between wires. Everything above it (contract, plugins, hooks, UI) is identical.
export type TransportKind = 'websocket' | 'http' | 'libp2p'

export const TRANSPORT_LABELS: Record<TransportKind, string> = {
  websocket: 'WebSocket',
  http: 'HTTP (SSE)',
  libp2p: 'libp2p',
}

const isKind = (v: string | null): v is TransportKind => v !== null && v in TRANSPORT_LABELS

/** The wire is chosen per tab by `?transport=…`, so two tabs can hold two different wires at once. */
const kindFromUrl = (): TransportKind => {
  const asked = new URLSearchParams(location.search).get('transport')
  return isKind(asked) ? asked : 'websocket'
}

/** Reload onto another wire. The access token lives in localStorage, so you stay signed in. */
export function switchTransport(next: TransportKind): void {
  const url = new URL(location.href)
  url.searchParams.set('transport', next)
  location.assign(url)
}

const host = location.host
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`
const httpUrl = `${location.protocol}//${host}` // origin; httpClientTransport basePath defaults to /superline

async function browserNode(): Promise<Libp2p> {
  return createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false }, // allow the localhost dev dial
    services: { identify: identify() },
    // no addresses.listen — the browser only dials
  })
}

// The server hands us its libp2p port + stable PeerId; the browser dials it directly (published port).
async function serverMultiaddr() {
  const res = await fetch(`${httpUrl}/libp2p-addr`)
  const { port, peerId } = (await res.json()) as { port: number; peerId: string }
  return multiaddr(`/dns4/${location.hostname}/tcp/${port}/ws/p2p/${peerId}`)
}

async function transportFor(k: TransportKind): Promise<ClientTransport> {
  if (k === 'websocket') return webSocketClientTransport({ url: wsUrl })
  if (k === 'http') return httpClientTransport({ url: httpUrl }) // EventSource + fetch are browser globals
  const [node, addr] = await Promise.all([browserNode(), serverMultiaddr()])
  return libp2pClientTransport({ node, multiaddr: addr })
}

/** This tab's wire. */
export const kind = kindFromUrl()

/**
 * Resolved with a TOP-LEVEL await, on purpose: libp2p needs an awaited node plus a fetched multiaddr,
 * but `createAuth()` connects the moment it is called at module scope and takes its transport
 * synchronously. ESM settles this module's await before `lib/auth.ts` — its importer — evaluates, so
 * the ordering is guaranteed by the module graph instead of by ceremony in the entry point.
 */
export const transport: ClientTransport = await transportFor(kind)
