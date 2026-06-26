import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

// The relay's identity is deterministic so every peer can compute its bootstrap multiaddr with no
// registry (same trick scaling-libp2p uses). Discovery of the *servers* is dynamic via
// pubsub-peer-discovery — only the relay (the one fixed, public node) is pinned here.
export const RELAY_PORT = 9000

function seedFor(name: string): Uint8Array {
  const seed = new Uint8Array(32)
  new TextEncoder().encodeInto(name, seed)
  return seed
}
export const keyFor = (name: string) => generateKeyPairFromSeed('Ed25519', seedFor(name))

export const relayKey = await keyFor('relay')
export const relayPeerId = peerIdFromPrivateKey(relayKey).toString()

// Works in Node (process.env) and the browser (caller passes import.meta.env value). 127.0.0.1 → /ip4,
// a docker service name like "relay" → /dns4.
export function relayMultiaddr(host: string): string {
  const hostPart = /^[0-9.]+$/.test(host) ? `/ip4/${host}` : `/dns4/${host}`
  return `${hostPart}/tcp/${RELAY_PORT}/ws/p2p/${relayPeerId}`
}

// The shared gossipsub topic pubsub-peer-discovery broadcasts/discovers on. Everyone broadcasts
// (a purely-listenOnly node behind the relay doesn't reliably receive); roles are told apart by the
// known-server set below, not by who broadcasts.
export const DISCOVERY_TOPIC = 'super-line-nat/_peer-discovery'

// Servers have deterministic identities, so every peer can compute the set of *server* PeerIds and
// use it to role-filter discovery: servers only mesh-dial other servers, browsers only connect to
// servers — never to each other. pubsub still provides liveness (you act on servers you actually
// hear from). Browsers get these as precomputed public strings via env (no private keys shipped).
export async function serverPeerId(name: string): Promise<string> {
  return peerIdFromPrivateKey(await keyFor(name)).toString()
}
export async function serverPeerIdSet(names: string[]): Promise<Set<string>> {
  return new Set(await Promise.all(names.map(serverPeerId)))
}
