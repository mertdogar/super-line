import { getLogger } from '@logtape/logtape'
import { createLibp2p, type Libp2pOptions } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { mdns, type MulticastDNSInit } from '@libp2p/mdns'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport, circuitRelayServer, type CircuitRelayServerInit } from '@libp2p/circuit-relay-v2'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { dcutr } from '@libp2p/dcutr'
import { multiaddr } from '@multiformats/multiaddr'
import { loadOrCreateSelfKey } from '@libp2p/config'
import { FsDatastore } from 'datastore-fs'
import { gossipsub, type GossipSub, type Message } from '@libp2p/gossipsub'
import type { Libp2p, PrivateKey } from '@libp2p/interface'
import type { Adapter } from '@super-line/core'
import { startDnsDiscovery, type DnsDiscoveryInit } from './dns.js'
import { GossipPresence, type PresenceMsg } from './presence.js'

/** A libp2p node whose services expose a gossipsub `pubsub`. */
export type PubSubLibp2p = Libp2p<{ pubsub: GossipSub }>

export type { MulticastDNSInit, CircuitRelayServerInit, DnsDiscoveryInit }

/**
 * How the built-in node finds its peers. Strategies compose — pass an array to
 * combine (e.g. mDNS on the LAN plus one cross-subnet seed).
 *
 * - `'mdns'` / `{ mdns: opts }` — multicast DNS on the local network (LANs, docker
 *   networks). Zero addresses to configure and no stable identity needed: peers
 *   re-find each other after restarts. The object form passes `@libp2p/mdns`
 *   options through.
 * - `{ bootstrap: [...] }` — static seed multiaddrs (incl. `/p2p/<peerId>`) dialed
 *   on startup. The classic fixed-seed topology.
 * - `{ dns: { hostname, port } }` — repeatedly resolves every A/AAAA record and
 *   dials each endpoint. Designed for Kubernetes headless Services and other
 *   dynamic DNS membership; no stable peer identity is needed.
 * - `{ relay: addr }` — multiaddr(s) of a circuit-relay-v2 node (run one with
 *   {@link createRelayNode}) for nodes that cannot reach each other directly
 *   (NAT). Adds WebSocket + circuit-relay transports, a `/p2p-circuit` listen
 *   address, pubsub peer discovery on `<topic>/_peer-discovery`, and DCUtR so
 *   relayed links upgrade to direct connections where the network allows.
 */
export type Discovery =
  | 'mdns'
  | { mdns: MulticastDNSInit }
  | { bootstrap: string[] }
  | { dns: DnsDiscoveryInit }
  | { relay: string | string[] }

/** Options for {@link createLibp2pAdapter}. */
export interface Libp2pAdapterOptions {
  /**
   * Bring your own (started) libp2p node. It must expose a gossipsub `pubsub`
   * service (the adapter does its own loopback, so `emitSelf` can be left off).
   * When provided, the adapter does NOT manage the node's lifecycle — `close()`
   * leaves it running — and node-building options (`discovery`, `listen`, …)
   * don't apply: you own the node's topology.
   */
  node?: PubSubLibp2p
  /**
   * How the built-in node discovers peers — see {@link Discovery}. Omit for no
   * discovery: a valid single-node setup, or a seed that others point at via
   * `{ bootstrap }`. Discovered peers are dialed automatically, so the gossipsub
   * mesh forms without extra wiring.
   */
  discovery?: Discovery | Discovery[]
  /**
   * Listen multiaddrs for the built-in node. Defaults to `['/ip4/0.0.0.0/tcp/0']`
   * (or `/ws` for the WebSocket transport). Seed nodes should use a FIXED port so
   * their multiaddr stays valid in others' bootstrap lists.
   */
  listen?: string[]
  /** Transport for the built-in node. Defaults to `'tcp'`. */
  transport?: 'tcp' | 'ws'
  /**
   * Peer identity for the built-in node: a raw `PrivateKey`, or `{ path }` to load-or-create
   * a persistent Ed25519 key on disk (stable peer ID across restarts). Omit for an ephemeral
   * key — with purely dynamic discovery (mdns/dns/relay) that's fine, since nothing references
   * your peer ID; otherwise a startup warning fires because bootstrap lists break on restart.
   */
  identity?: PrivateKey | { path: string }
  /** The single shared gossipsub topic every node joins. Defaults to `'super-line/v1'`. */
  topic?: string
  /**
   * Cluster presence directory (powers `srv.cluster.*` / `srv.isOnline`). On by default;
   * set `false` to disable (cluster queries then throw). Pass an object to tune timings.
   */
  presence?: false | { snapshotIntervalMs?: number; livenessTtlMs?: number }
}

const DEFAULT_TOPIC = 'super-line/v1'
const logNode = getLogger(['super-line', 'adapter-libp2p', 'node'])
const logPeer = getLogger(['super-line', 'adapter-libp2p', 'peer'])
const logGossip = getLogger(['super-line', 'adapter-libp2p', 'gossip'])
const logDiscovery = getLogger(['super-line', 'adapter-libp2p', 'discovery'])

// reserved internal channel for presence gossip; can't collide with r:/t:/c:/u:/reply:/s2s
const PRESENCE_CHANNEL = '\x00sl:presence'
const enc = new TextEncoder()
const dec = new TextDecoder()

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const relayAddrsOf = (s: Discovery): string[] => (typeof s === 'object' && 'relay' in s ? asArray(s.relay) : [])
const discoveryTopicFor = (topic: string): string => `${topic}/_peer-discovery`

// [u16 channelLen][channel utf8][u8 kind: 0=string 1=binary][payload], so binary payloads survive.
function frame(channel: string, payload: string | Uint8Array): Uint8Array {
  const ch = enc.encode(channel)
  const isStr = typeof payload === 'string'
  const body = isStr ? enc.encode(payload) : payload
  const out = new Uint8Array(2 + ch.length + 1 + body.length)
  new DataView(out.buffer).setUint16(0, ch.length)
  out.set(ch, 2)
  out[2 + ch.length] = isStr ? 0 : 1
  out.set(body, 3 + ch.length)
  return out
}

function unframe(data: Uint8Array): { channel: string; payload: string | Uint8Array } {
  const chLen = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0)
  const channel = dec.decode(data.subarray(2, 2 + chLen))
  const body = data.subarray(3 + chLen)
  const payload = data[2 + chLen] === 0 ? dec.decode(body) : body
  return { channel, payload }
}

async function resolveIdentity(identity: Libp2pAdapterOptions['identity'], quiet = false): Promise<PrivateKey | undefined> {
  if (identity === undefined) {
    if (!quiet)
      console.warn(
        '[super-line/adapter-libp2p] no identity provided — using an ephemeral peer ID; bootstrap lists break across restarts. Pass `identity: { path }` to persist it.',
      )
    return undefined
  }
  if ('path' in identity) {
    const datastore = new FsDatastore(identity.path)
    await datastore.open()
    try {
      return await loadOrCreateSelfKey(datastore)
    } finally {
      await datastore.close()
    }
  }
  return identity // a raw PrivateKey
}

async function buildNode(opts: Libp2pAdapterOptions, strategies: Discovery[], topic: string): Promise<PubSubLibp2p> {
  const ws = opts.transport === 'ws'
  const hasRelay = strategies.some((s) => relayAddrsOf(s).length > 0)
  // Dynamic discovery (mdns/dns/relay) re-finds peers after a restart, so an ephemeral peer ID
  // is fine and the stable-identity warning would be noise. With bootstrap in play (or no
  // discovery at all — likely a seed others point at), peer IDs live in static lists: warn.
  const dynamicOnly =
    strategies.length > 0 && strategies.every((s) => s === 'mdns' || 'mdns' in s || 'dns' in s || 'relay' in s)
  const privateKey = await resolveIdentity(opts.identity, dynamicOnly)

  const peerDiscovery: NonNullable<Libp2pOptions['peerDiscovery']> = []
  for (const s of strategies) {
    if (s === 'mdns') peerDiscovery.push(mdns())
    else if ('mdns' in s) peerDiscovery.push(mdns(s.mdns))
    else if ('bootstrap' in s && s.bootstrap.length > 0) peerDiscovery.push(bootstrap({ list: s.bootstrap }))
    // relay strategies share the single pubsubPeerDiscovery below
  }
  if (hasRelay) peerDiscovery.push(pubsubPeerDiscovery({ topics: [discoveryTopicFor(topic)], interval: 5_000 }))

  const listen = opts.listen ?? [ws ? '/ip4/0.0.0.0/tcp/0/ws' : '/ip4/0.0.0.0/tcp/0']
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: hasRelay ? [...listen, '/p2p-circuit'] : listen },
    transports: [ws ? webSockets() : tcp(), ...(hasRelay ? [...(ws ? [] : [webSockets()]), circuitRelayTransport()] : [])],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // circuit addrs are deny-by-default; the relay path must be dialable
    ...(hasRelay ? { connectionGater: { denyDialMultiaddr: () => false } } : {}),
    peerDiscovery,
    services: {
      identify: identify(),
      // the adapter does its own loopback, so emitSelf stays off (default) — no double delivery
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      ...(hasRelay ? { dcutr: dcutr() } : {}),
    },
  })
  // Discovery only FINDS peers (mdns and pubsub-discovery never dial) — dial them, or the
  // gossipsub mesh silently never forms. Dial by peer ID (not the raw multiaddrs): libp2p then
  // uses the peer store + transport fallbacks, which the bare direct addrs a relay advertises
  // (no /p2p/ suffix) don't survive as a raw array-dial. Re-dials to a live peer are no-ops.
  node.addEventListener('peer:discovery', (e) => {
    const peer = e.detail.id.toString()
    logDiscovery.debug('discovered {peer} — dialing to form the mesh', { peer })
    void node.dial(e.detail.id).then(
      () => logDiscovery.debug('dialed {peer}', { peer }),
      (err) => logDiscovery.debug('dial to {peer} failed {error}', { peer, error: err }),
    )
  })
  // gossipsub implements PubSub; libp2p's service generics are invariant, so widen explicitly.
  return node as unknown as PubSubLibp2p
}

// Startup rendezvous: retry each relay (cluster and relay often boot together, e.g. docker-compose);
// succeed if ANY relay answers, throw only when all stay unreachable — an unreachable relay means
// an invisible island, which should fail loudly.
async function dialRelays(node: PubSubLibp2p, relays: string[]): Promise<void> {
  const attempt = async (addr: string): Promise<void> => {
    const ma = multiaddr(addr)
    for (let i = 1; ; i++) {
      try {
        await node.dial(ma, { signal: AbortSignal.timeout(5_000) })
        logDiscovery.debug('reached relay {addr} (attempt {attempt})', { addr, attempt: i })
        return
      } catch (err) {
        if (i >= 15) throw err
        logDiscovery.debug('relay {addr} unreachable, retrying (attempt {attempt})', { addr, attempt: i })
        await new Promise((r) => setTimeout(r, 1_000))
      }
    }
  }
  const results = await Promise.allSettled(relays.map(attempt))
  if (results.every((r) => r.status === 'rejected'))
    throw new Error(`createLibp2pAdapter: could not reach any relay (${relays.join(', ')})`, {
      cause: (results[0] as PromiseRejectedResult).reason,
    })
}

/**
 * Create a libp2p (gossipsub) {@link Adapter} for decentralized, broker-less
 * multi-node fan-out. All channels ride one shared gossipsub topic; each node
 * filters incoming messages by its local subscriptions, so `subscribe` /
 * `unsubscribe` are local bookkeeping with no network round-trip. At-most-once
 * delivery, matching the library's model.
 *
 * @param options - {@link Libp2pAdapterOptions} (bring your own node, or let the
 *   adapter build one and point `discovery` at how peers find each other).
 * @example
 * ```ts
 * // LAN / docker network — peers find each other over multicast, zero addresses
 * const adapter = await createLibp2pAdapter({ discovery: 'mdns' })
 *
 * // fixed-seed topology
 * const adapter = await createLibp2pAdapter({ discovery: { bootstrap: ['/ip4/10.0.0.1/tcp/9001/p2p/12D3Koo…'] } })
 *
 * // Kubernetes headless Service — every replica is an ephemeral peer
 * const adapter = await createLibp2pAdapter({
 *   listen: ['/ip4/0.0.0.0/tcp/9001'],
 *   discovery: { dns: { hostname: 'super-line-p2p.default.svc.cluster.local', port: 9001 } },
 * })
 *
 * // NAT'd nodes meshing through a public relay (see createRelayNode)
 * const adapter = await createLibp2pAdapter({ discovery: { relay: '/dns4/relay.example.com/tcp/9000/ws/p2p/12D3Koo…' } })
 * ```
 */
export async function createLibp2pAdapter(
  options: Libp2pAdapterOptions = {},
): Promise<Adapter & { node: PubSubLibp2p }> {
  const topic = options.topic ?? DEFAULT_TOPIC
  const strategies = asArray(options.discovery)
  const ownsNode = options.node === undefined
  if (!ownsNode && strategies.length > 0)
    throw new Error(
      "createLibp2pAdapter: `discovery` configures the built-in node — with a bring-your-own `node`, wire peerDiscovery on the node itself",
    )
  const node = options.node ?? (await buildNode(options, strategies, topic))
  const pubsub = node.services.pubsub
  if (!pubsub || typeof pubsub.publish !== 'function' || typeof pubsub.subscribe !== 'function') {
    throw new Error('createLibp2pAdapter: the libp2p node must expose a gossipsub `pubsub` service')
  }
  if (ownsNode) {
    const relays = strategies.flatMap(relayAddrsOf)
    if (relays.length > 0) await dialRelays(node, relays)
  }
  const selfPeer = node.peerId.toString()
  logNode.info('adapter node ready {peer} on {addrs}', {
    peer: selfPeer,
    addrs: node.getMultiaddrs().map(String),
    topic,
  })
  const onPeerConnect = (e: CustomEvent<{ toString(): string }>) =>
    logPeer.debug('peer connected {peer}', { peer: e.detail.toString() })
  const onPeerDisconnect = (e: CustomEvent<{ toString(): string }>) =>
    logPeer.debug('peer disconnected {peer}', { peer: e.detail.toString() })
  node.addEventListener('peer:connect', onPeerConnect as EventListener)
  node.addEventListener('peer:disconnect', onPeerDisconnect as EventListener)
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  const publishFramed = async (channel: string, payload: string | Uint8Array): Promise<void> => {
    if (closed) return
    // explicit loopback to our own local members — don't depend on the node's emitSelf setting
    if (channel !== PRESENCE_CHANNEL && subscribed.has(channel)) handler?.(channel, payload)
    try {
      await pubsub.publish(topic, frame(channel, payload))
    } catch (err) {
      // at-most-once: a publish lost (e.g. before the mesh forms) is acceptable
      logGossip.trace('publish dropped on {channel} (mesh not ready?) {error}', { channel, error: err })
    }
  }

  const presence =
    options.presence === false
      ? undefined
      : new GossipPresence(
          (msg) => void publishFramed(PRESENCE_CHANNEL, JSON.stringify(msg)),
          typeof options.presence === 'object' ? options.presence : {},
        )

  const onMessage = (evt: CustomEvent<Message>): void => {
    const m = evt.detail
    if (m.topic !== topic) return
    if (m.type === 'signed' && m.from.toString() === selfPeer) return // our own echo — already looped back
    const { channel, payload } = unframe(m.data)
    if (channel === PRESENCE_CHANNEL) {
      presence?.receive(JSON.parse(payload as string) as PresenceMsg)
      return
    }
    if (subscribed.has(channel)) {
      logGossip.trace('message on {channel} from {from}', {
        channel,
        from: m.type === 'signed' ? m.from.toString() : 'unsigned',
      })
      handler?.(channel, payload)
    }
  }
  pubsub.addEventListener('message', onMessage)
  pubsub.subscribe(topic)
  const stopDnsDiscovery = ownsNode
    ? strategies
        .filter((s): s is { dns: DnsDiscoveryInit } => typeof s === 'object' && 'dns' in s)
        .map((s) => startDnsDiscovery(node, s.dns))
    : []

  return {
    node, // exposed so callers can read peerId / multiaddrs (e.g. to build bootstrap lists)
    subscribe(channel) {
      logGossip.debug('subscribe {channel}', { channel })
      subscribed.add(channel)
    },
    unsubscribe(channel) {
      logGossip.debug('unsubscribe {channel}', { channel })
      subscribed.delete(channel)
    },
    publish: publishFramed,
    onMessage(h) {
      handler = h
    },
    presence,
    async close() {
      if (closed) return
      closed = true
      logNode.debug('adapter node closing {peer}', { peer: selfPeer })
      presence?.stop()
      for (const stop of stopDnsDiscovery) stop()
      pubsub.removeEventListener('message', onMessage)
      node.removeEventListener('peer:connect', onPeerConnect as EventListener)
      node.removeEventListener('peer:disconnect', onPeerDisconnect as EventListener)
      if (ownsNode) await node.stop()
    },
  }
}

/** Options for {@link createRelayNode}. */
export interface RelayNodeOptions {
  /** TCP port of the WebSocket listener. Defaults to `9000`. Ignored when `listen` is given. */
  port?: number
  /** Listen multiaddrs. Defaults to `['/ip4/0.0.0.0/tcp/<port>/ws']`. */
  listen?: string[]
  /**
   * Same semantics as the adapter's `identity`. PERSIST IT: every server's `{ relay }` addr
   * embeds this node's peer ID, so an ephemeral key invalidates them all on restart.
   */
  identity?: PrivateKey | { path: string }
  /**
   * Adapter topic of the cluster this relay serves (default `'super-line/v1'`) — only used
   * to derive the `<topic>/_peer-discovery` gossip topic the relay bridges.
   */
  topic?: string
  /** circuit-relay-v2 server tuning (reservation limits etc.), passed through. */
  relay?: CircuitRelayServerInit
}

/**
 * Run the one public rendezvous node a `{ relay }` discovery strategy points at.
 * It does two jobs on a single WebSocket-reachable libp2p node: a circuit-relay-v2
 * server (NAT'd nodes reserve a slot and become dialable via `/p2p-circuit`) and a
 * gossipsub bridge for the peer-discovery topic (`listenOnly` — it forwards without
 * advertising itself). Adapter traffic never routes through its pubsub: servers mesh
 * directly over their circuit (or DCUtR-upgraded) connections.
 *
 * @example
 * ```ts
 * const relay = await createRelayNode({ port: 9000, identity: { path: './relay-key' } })
 * console.log(relay.getMultiaddrs().map(String)) // hand this to every server's `discovery.relay`
 * ```
 */
export async function createRelayNode(options: RelayNodeOptions = {}): Promise<Libp2p> {
  const privateKey = await resolveIdentity(options.identity)
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: options.listen ?? [`/ip4/0.0.0.0/tcp/${options.port ?? 9000}/ws`] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    peerDiscovery: [pubsubPeerDiscovery({ topics: [discoveryTopicFor(options.topic ?? DEFAULT_TOPIC)], listenOnly: true })],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      relay: circuitRelayServer(options.relay),
    },
  })
  return node as unknown as Libp2p
}
