import { randomUUID } from 'node:crypto'
import { Publisher, Subscriber } from 'zeromq'
import type { Adapter } from '@super-line/core'

/** Brokerless full-mesh: this node binds a PUB and connects a SUB to every peer's PUB. */
export interface ZeroMqMeshOptions {
  mode?: 'mesh'
  /** This node's own PUB endpoint to bind (e.g. `tcp://0.0.0.0:5555`, or `tcp://127.0.0.1:0` for an OS-picked port). */
  bind: string
  /** Other nodes' PUB endpoints to connect a SUB to. Lazy + auto-reconnecting, so peers may start later. */
  peers?: string[]
  /** PUB/SUB high-water-mark (messages buffered per peer before silent drops). Defaults to `100_000`. */
  sendHighWaterMark?: number
}

/** Options for {@link createZeroMqAdapter}. */
export type ZeroMqAdapterOptions = ZeroMqMeshOptions

/** A mesh adapter also exposes its resolved bind endpoint, so a node bound to `:0` can advertise it to peers. */
export type ZeroMqAdapter = Adapter & { endpoint: string }

const DEFAULT_HWM = 100_000
const toFrame = (payload: string | Uint8Array): string | Buffer =>
  typeof payload === 'string' ? payload : Buffer.from(payload)

/**
 * Wire a started PUB + SUB pair into the {@link Adapter} contract. Messages are
 * multipart `[channel, senderId, payload]`; `senderId` lets a node drop its own
 * echo (the proxy forwarder bounces a publish back to its sender), so local
 * delivery is always the explicit in-process loopback — one code path for mesh
 * and proxy alike. Payloads ride as raw bytes (Buffer), matching the Redis adapter.
 */
function wireAdapter(pub: Publisher, sub: Subscriber, ownsSockets: boolean): Adapter {
  const selfId = randomUUID()
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  void (async () => {
    try {
      for await (const frames of sub) {
        if (closed) break
        const [chBuf, sidBuf, payloadBuf] = frames
        if (!chBuf) continue
        if (sidBuf?.toString() === selfId) continue // our own echo (proxy bounce) — already looped back
        handler?.(chBuf.toString(), payloadBuf ?? Buffer.alloc(0))
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
    async publish(channel, payload) {
      if (closed) return
      if (subscribed.has(channel)) handler?.(channel, payload) // explicit local loopback
      try {
        await pub.send([channel, selfId, toFrame(payload)])
      } catch {
        // at-most-once: a publish lost during a blip is acceptable
      }
    },
    onMessage(h) {
      handler = h
    },
    async close() {
      if (closed) return
      closed = true
      if (ownsSockets) {
        pub.close()
        sub.close()
      }
    },
  }
}

/**
 * Create a ZeroMQ {@link Adapter} for multi-node fan-out. Brokerless full mesh:
 * this node binds a PUB and connects a SUB to every peer. ZeroMQ's lazy connect
 * + auto-reconnect mean peers may start in any order. At-most-once delivery,
 * matching the library's model.
 *
 * @param options - {@link ZeroMqAdapterOptions}.
 * @example
 * ```ts
 * const adapter = await createZeroMqAdapter({ bind: 'tcp://0.0.0.0:5555', peers: ['tcp://node-b:5555'] })
 * createSocketServer(api, { server, adapter })
 * ```
 */
export async function createZeroMqAdapter(options: ZeroMqAdapterOptions): Promise<ZeroMqAdapter> {
  const hwm = options.sendHighWaterMark ?? DEFAULT_HWM
  const pub = new Publisher({ sendHighWaterMark: hwm })
  const sub = new Subscriber({ receiveHighWaterMark: hwm })
  await pub.bind(options.bind)
  for (const peer of options.peers ?? []) sub.connect(peer)
  return { ...wireAdapter(pub, sub, true), endpoint: pub.lastEndpoint ?? options.bind }
}
