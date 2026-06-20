import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { webSockets } from '@libp2p/websockets'
import { loadOrCreateSelfKey } from '@libp2p/config'
import { FsDatastore } from 'datastore-fs'
import { gossipsub, type GossipSub, type Message } from '@libp2p/gossipsub'
import type { Libp2p, PrivateKey } from '@libp2p/interface'
import type { Adapter } from '@super-line/core'
import { GossipPresence, type PresenceMsg } from './presence.js'

/** A libp2p node whose services expose a gossipsub `pubsub`. */
export type PubSubLibp2p = Libp2p<{ pubsub: GossipSub }>

/** Options for {@link createLibp2pAdapter}. */
export interface Libp2pAdapterOptions {
  /**
   * Bring your own (started) libp2p node. It must expose a gossipsub `pubsub`
   * service (the adapter does its own loopback, so `emitSelf` can be left off).
   * When provided, the adapter does NOT manage the node's lifecycle — `close()`
   * leaves it running.
   */
  node?: PubSubLibp2p
  /**
   * Listen multiaddrs for the built-in node. Defaults to `['/ip4/0.0.0.0/tcp/0']`
   * (or `/ws` for the WebSocket transport). Seed nodes should use a FIXED port so
   * their multiaddr stays valid in others' bootstrap lists.
   */
  listen?: string[]
  /** Bootstrap seed multiaddrs (incl. `/p2p/<peerId>`) the built-in node dials on startup. */
  bootstrap?: string[]
  /** Transport for the built-in node. Defaults to `'tcp'`. */
  transport?: 'tcp' | 'ws'
  /**
   * Peer identity for the built-in node: a raw `PrivateKey`, or `{ path }` to load-or-create
   * a persistent Ed25519 key on disk (stable peer ID across restarts). Omit for an ephemeral
   * key — convenient for dev, but a startup warning fires since bootstrap lists break on restart.
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
// reserved internal channel for presence gossip; can't collide with r:/t:/c:/u:/reply:/s2s
const PRESENCE_CHANNEL = '\x00sl:presence'
const enc = new TextEncoder()
const dec = new TextDecoder()

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

async function resolveIdentity(identity: Libp2pAdapterOptions['identity']): Promise<PrivateKey | undefined> {
  if (identity === undefined) {
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

async function buildNode(opts: Libp2pAdapterOptions): Promise<PubSubLibp2p> {
  const list = opts.bootstrap ?? []
  const ws = opts.transport === 'ws'
  const privateKey = await resolveIdentity(opts.identity)
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: opts.listen ?? [ws ? '/ip4/0.0.0.0/tcp/0/ws' : '/ip4/0.0.0.0/tcp/0'] },
    transports: [ws ? webSockets() : tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: list.length > 0 ? [bootstrap({ list })] : [],
    services: {
      identify: identify(),
      // the adapter does its own loopback, so emitSelf stays off (default) — no double delivery
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  })
  // gossipsub implements PubSub; libp2p's service generics are invariant, so widen explicitly.
  return node as unknown as PubSubLibp2p
}

/**
 * Create a libp2p (gossipsub) {@link Adapter} for decentralized, broker-less
 * multi-node fan-out. All channels ride one shared gossipsub topic; each node
 * filters incoming messages by its local subscriptions, so `subscribe` /
 * `unsubscribe` are local bookkeeping with no network round-trip. At-most-once
 * delivery, matching the library's model.
 *
 * @param options - {@link Libp2pAdapterOptions} (bring your own node, or let the
 *   adapter build one from `listen` / `bootstrap`).
 * @example
 * ```ts
 * const adapter = await createLibp2pAdapter({ bootstrap: ['/ip4/10.0.0.1/tcp/9001/p2p/12D3Koo...'] })
 * createSocketServer(api, { server, adapter })
 * ```
 */
export async function createLibp2pAdapter(
  options: Libp2pAdapterOptions = {},
): Promise<Adapter & { node: PubSubLibp2p }> {
  const topic = options.topic ?? DEFAULT_TOPIC
  const ownsNode = options.node === undefined
  const node = options.node ?? (await buildNode(options))
  const pubsub = node.services.pubsub
  if (!pubsub || typeof pubsub.publish !== 'function' || typeof pubsub.subscribe !== 'function') {
    throw new Error('createLibp2pAdapter: the libp2p node must expose a gossipsub `pubsub` service')
  }
  const selfPeer = node.peerId.toString()
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  const publishFramed = async (channel: string, payload: string | Uint8Array): Promise<void> => {
    if (closed) return
    // explicit loopback to our own local members — don't depend on the node's emitSelf setting
    if (channel !== PRESENCE_CHANNEL && subscribed.has(channel)) handler?.(channel, payload)
    try {
      await pubsub.publish(topic, frame(channel, payload))
    } catch {
      // at-most-once: a publish lost (e.g. before the mesh forms) is acceptable
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
    if (subscribed.has(channel)) handler?.(channel, payload)
  }
  pubsub.addEventListener('message', onMessage)
  pubsub.subscribe(topic)

  return {
    node, // exposed so callers can read peerId / multiaddrs (e.g. to build bootstrap lists)
    subscribe(channel) {
      subscribed.add(channel)
    },
    unsubscribe(channel) {
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
      presence?.stop()
      pubsub.removeEventListener('message', onMessage)
      if (ownsNode) await node.stop()
    },
  }
}
