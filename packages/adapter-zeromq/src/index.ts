import { randomUUID } from 'node:crypto'
import { Proxy, Publisher, Subscriber, XPublisher, XSubscriber } from 'zeromq'
import type { Adapter } from '@super-line/core'
import { GossipPresence, type PresenceMsg } from './presence.js'

/**
 * Cluster presence directory (powers `srv.cluster.*` / `srv.isOnline`). On by default;
 * set `false` to disable (cluster queries then throw). Pass an object to tune timings.
 */
export type ZeroMqPresenceOption = false | { snapshotIntervalMs?: number; livenessTtlMs?: number }

/** Brokerless full-mesh: this node binds a PUB and connects a SUB to every peer's PUB. */
export interface ZeroMqMeshOptions {
  mode?: 'mesh'
  /** This node's own PUB endpoint to bind (e.g. `tcp://0.0.0.0:5555`, or `tcp://127.0.0.1:0` for an OS-picked port). */
  bind: string
  /** Other nodes' PUB endpoints to connect a SUB to. Lazy + auto-reconnecting, so peers may start later. */
  peers?: string[]
  /** PUB/SUB high-water-mark (messages buffered per peer before silent drops). Defaults to `100_000`. */
  sendHighWaterMark?: number
  /** Cluster presence directory. On by default. */
  presence?: ZeroMqPresenceOption
}

/** Central forwarder: this node connects its PUB to the proxy frontend and its SUB to the backend. */
export interface ZeroMqProxyModeOptions {
  mode: 'proxy'
  /** The proxy's frontend (XSUB) endpoint — this node's PUB connects here. */
  frontendUrl: string
  /** The proxy's backend (XPUB) endpoint — this node's SUB connects here. */
  backendUrl: string
  /** PUB/SUB high-water-mark. Defaults to `100_000`. */
  sendHighWaterMark?: number
  /** Cluster presence directory. On by default. */
  presence?: ZeroMqPresenceOption
}

/** Bring your own pre-wired sockets — the adapter uses them as-is and does NOT own their lifecycle. */
export interface ZeroMqByoOptions {
  /** A PUB socket you've already bound/connected. */
  pub: Publisher
  /** A SUB socket you've already connected (the adapter calls `subscribe`/`unsubscribe` on it). */
  sub: Subscriber
  /** Cluster presence directory. On by default. */
  presence?: ZeroMqPresenceOption
}

/** Options for {@link createZeroMqAdapter}. */
export type ZeroMqAdapterOptions = ZeroMqMeshOptions | ZeroMqProxyModeOptions | ZeroMqByoOptions

/** A mesh adapter also exposes its resolved bind endpoint, so a node bound to `:0` can advertise it to peers. */
export type ZeroMqAdapter = Adapter & { endpoint: string }

const DEFAULT_HWM = 100_000
// reserved internal channel for presence gossip; can't collide with r:/t:/c:/u:/reply:/s2s
const PRESENCE_CHANNEL = '\x00sl:presence'
const toFrame = (payload: string | Uint8Array): string | Buffer =>
  typeof payload === 'string' ? payload : Buffer.from(payload)

/**
 * Wire a started PUB + SUB pair into the {@link Adapter} contract. Messages are
 * multipart `[channel, senderId, payload]`; `senderId` lets a node drop its own
 * echo (the proxy forwarder bounces a publish back to its sender), so local
 * delivery is always the explicit in-process loopback — one code path for mesh
 * and proxy alike. Payloads ride as raw bytes (Buffer), matching the Redis adapter.
 * Presence rides the reserved {@link PRESENCE_CHANNEL} as gossip (no central store).
 */
function wireAdapter(pub: Publisher, sub: Subscriber, ownsSockets: boolean, presenceOpt: ZeroMqPresenceOption | undefined): Adapter {
  const selfId = randomUUID()
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  const send = async (channel: string, payload: string | Uint8Array): Promise<void> => {
    if (closed) return
    if (subscribed.has(channel)) handler?.(channel, payload) // explicit local loopback
    try {
      await pub.send([channel, selfId, toFrame(payload)])
    } catch {
      // at-most-once: a publish lost during a blip is acceptable
    }
  }

  const presence =
    presenceOpt === false
      ? undefined
      : new GossipPresence((m) => void send(PRESENCE_CHANNEL, JSON.stringify(m)), typeof presenceOpt === 'object' ? presenceOpt : {})

  sub.subscribe(PRESENCE_CHANNEL) // always receive peers' presence gossip

  void (async () => {
    try {
      for await (const frames of sub) {
        if (closed) break
        const [chBuf, sidBuf, payloadBuf] = frames
        if (!chBuf) continue
        if (sidBuf?.toString() === selfId) continue // our own echo (proxy bounce) — already looped back
        const channel = chBuf.toString()
        if (channel === PRESENCE_CHANNEL) {
          presence?.receive(JSON.parse((payloadBuf ?? Buffer.alloc(0)).toString()) as PresenceMsg)
          continue
        }
        handler?.(channel, payloadBuf ?? Buffer.alloc(0))
      }
    } catch {
      // socket closed during shutdown — fine
    }
  })()

  return {
    subscribe(channel) {
      subscribed.add(channel)
      sub.subscribe(channel)
    },
    unsubscribe(channel) {
      subscribed.delete(channel)
      sub.unsubscribe(channel)
    },
    publish: send,
    onMessage(h: (channel: string, payload: string | Uint8Array) => void) {
      handler = h
    },
    presence,
    async close() {
      if (closed) return
      closed = true
      presence?.stop()
      if (ownsSockets) {
        pub.close()
        sub.close()
      }
    },
  }
}

/**
 * Create a ZeroMQ {@link Adapter} for multi-node fan-out. Three shapes:
 * - **mesh** (default): brokerless full mesh — this node binds a PUB and connects
 *   a SUB to every peer. Returns the resolved bind `endpoint`.
 * - **proxy**: connect through a central {@link createZeroMqProxy} forwarder.
 * - **BYO**: hand in your own pre-wired `{ pub, sub }` sockets (the adapter does
 *   not own their lifecycle — `close()` leaves them open).
 *
 * ZeroMQ's lazy connect + auto-reconnect mean peers may start in any order.
 * At-most-once delivery, matching the library's model.
 *
 * @example
 * ```ts
 * const adapter = await createZeroMqAdapter({ bind: 'tcp://0.0.0.0:5555', peers: ['tcp://node-b:5555'] })
 * createSocketServer(api, { server, adapter })
 * ```
 */
export function createZeroMqAdapter(options: ZeroMqMeshOptions): Promise<ZeroMqAdapter>
export function createZeroMqAdapter(options: ZeroMqProxyModeOptions | ZeroMqByoOptions): Promise<Adapter>
export async function createZeroMqAdapter(options: ZeroMqAdapterOptions): Promise<Adapter> {
  if ('pub' in options) return wireAdapter(options.pub, options.sub, false, options.presence)

  const hwm = options.sendHighWaterMark ?? DEFAULT_HWM
  const pub = new Publisher({ sendHighWaterMark: hwm })
  const sub = new Subscriber({ receiveHighWaterMark: hwm })

  if (options.mode === 'proxy') {
    pub.connect(options.frontendUrl)
    sub.connect(options.backendUrl)
    return wireAdapter(pub, sub, true, options.presence)
  }

  await pub.bind(options.bind)
  for (const peer of options.peers ?? []) sub.connect(peer)
  const mesh: ZeroMqAdapter = { ...wireAdapter(pub, sub, true, options.presence), endpoint: pub.lastEndpoint ?? options.bind }
  return mesh
}

/** Options for {@link createZeroMqProxy}. */
export interface ZeroMqProxyOptions {
  /** Frontend (XSUB) endpoint to bind — node PUBs connect here to publish in. */
  frontendUrl: string
  /** Backend (XPUB) endpoint to bind — node SUBs connect here to receive. */
  backendUrl: string
  /** High-water-mark for both legs. Defaults to `100_000`. */
  sendHighWaterMark?: number
}

/** A running forwarder; `stop()` terminates it and unbinds both endpoints. */
export interface ZeroMqProxy {
  /** The resolved frontend (XSUB) endpoint node PUBs connect to. */
  frontendUrl: string
  /** The resolved backend (XPUB) endpoint node SUBs connect to. */
  backendUrl: string
  /** Terminate the proxy and release its sockets. */
  stop(): Promise<void>
}

/**
 * Run a ZeroMQ XSUB⇄XPUB forwarder — the central broker for `mode: 'proxy'`
 * adapters. Nodes connect their PUB to `frontendUrl` and their SUB to
 * `backendUrl`; the proxy relays every message (and propagates subscriptions
 * back to publishers, so native channel filtering still works through it).
 *
 * @example
 * ```ts
 * const proxy = await createZeroMqProxy({ frontendUrl: 'tcp://0.0.0.0:5557', backendUrl: 'tcp://0.0.0.0:5558' })
 * ```
 */
export async function createZeroMqProxy(options: ZeroMqProxyOptions): Promise<ZeroMqProxy> {
  const hwm = options.sendHighWaterMark ?? DEFAULT_HWM
  const proxy = new Proxy(
    new XSubscriber({ receiveHighWaterMark: hwm, sendHighWaterMark: hwm }),
    new XPublisher({ receiveHighWaterMark: hwm, sendHighWaterMark: hwm }),
  )
  await proxy.frontEnd.bind(options.frontendUrl)
  await proxy.backEnd.bind(options.backendUrl)
  const running = proxy.run().catch(() => {}) // resolves when terminated
  return {
    frontendUrl: proxy.frontEnd.lastEndpoint ?? options.frontendUrl,
    backendUrl: proxy.backEnd.lastEndpoint ?? options.backendUrl,
    async stop() {
      proxy.terminate()
      await running
    },
  }
}
