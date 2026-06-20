import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Connection } from 'rabbitmq-client'
import type { Adapter } from '@super-line/core'
import { GossipPresence, type PresenceMsg } from './presence.js'

/** Options for {@link createRabbitmqAdapter}. */
export interface RabbitmqAdapterOptions {
  /** `amqp://` (or `amqps://`) connection URL. The simple case. */
  url?: string
  /**
   * Bring your own (constructed) `rabbitmq-client` Connection — the advanced case (TLS,
   * multi-host failover, custom heartbeat, vhost). When provided, the adapter does NOT own its
   * lifecycle: `close()` leaves it open.
   */
  connection?: Connection
  /** The single durable `direct` exchange every node shares. Defaults to `'super-line'`. */
  exchange?: string
  /** Prefix for this node's exclusive auto-delete queue (`<prefix>.<uuid>`). Defaults to `'sl.node'`. */
  queuePrefix?: string
  /**
   * Cluster presence directory (powers `srv.cluster.*` / `srv.isOnline`). On by default; set
   * `false` to disable (cluster queries then throw). Pass an object to tune the gossip timings
   * (defaults: `snapshotIntervalMs` 10_000, `livenessTtlMs` 30_000).
   */
  presence?: false | { snapshotIntervalMs?: number; livenessTtlMs?: number }
}

const DEFAULT_EXCHANGE = 'super-line'
const DEFAULT_QUEUE_PREFIX = 'sl.node'
const MAX_ROUTING_KEY_BYTES = 255
// reserved routing key for presence gossip; can't collide with r:/t:/c:/u:/reply:/i:/s2s channels
const PRESENCE_KEY = 'sl.presence'

// AMQP 0.9.1 routing keys are shortstr (max 255 bytes); Redis/libp2p/memory have no such cap.
// Channel names embed user-controlled input (room / userId / topic), so surface an honest error
// rather than an opaque encoder RangeError (or, on the publish path, a silently swallowed send).
function assertKeyLen(channel: string): void {
  if (Buffer.byteLength(channel) > MAX_ROUTING_KEY_BYTES)
    throw new Error(
      `@super-line/adapter-rabbitmq: channel "${channel}" exceeds RabbitMQ's 255-byte routing-key limit`,
    )
}

/**
 * Create a RabbitMQ {@link Adapter} for broker-routed multi-node fan-out. Channels become routing
 * keys on one durable `direct` exchange; each node owns one exclusive, auto-delete queue and binds
 * only the channels it has local members for, so the broker selectively routes. At-most-once
 * delivery, matching the library's model. Built on `rabbitmq-client` (automatic reconnection +
 * topology recovery).
 *
 * @param options - an `amqp://` URL string or {@link RabbitmqAdapterOptions}.
 * @example
 * ```ts
 * const adapter = await createRabbitmqAdapter('amqp://localhost:5672')
 * createSocketServer(api, { server, adapter })
 * ```
 */
export async function createRabbitmqAdapter(
  options: RabbitmqAdapterOptions | string = {},
): Promise<Adapter & { connection: Connection }> {
  const opts = typeof options === 'string' ? { url: options } : options
  const exchange = opts.exchange ?? DEFAULT_EXCHANGE
  const queue = `${opts.queuePrefix ?? DEFAULT_QUEUE_PREFIX}.${randomUUID()}`
  const ownsConnection = opts.connection === undefined
  const connection = opts.connection ?? new Connection(opts.url)
  connection.on('error', () => {}) // swallow transient connection errors (match the Redis posture)

  await connection.onConnect()

  // confirm:false → fire-and-forget; the exchange is declared up front so the first publish lands.
  const publisher = connection.createPublisher({
    confirm: false,
    exchanges: [{ exchange, type: 'direct', durable: true }],
  })

  // Always-binary, never JSON/text-decoded — so the binary serializer output survives a round-trip.
  const sendToExchange = (channel: string, body: Buffer): Promise<void> =>
    publisher.send({ exchange, routingKey: channel, contentType: 'application/octet-stream' }, body)

  // The `subscribed` Set is the desired-state source of truth, replayed on every (re)connect.
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  // Presence rides the same exchange under the reserved `sl.presence` key. `lastBroadcast` lets
  // close() flush the final presence message (the graceful leave) before tearing the connection down.
  let lastBroadcast: Promise<void> | undefined
  const presence =
    opts.presence === false
      ? undefined
      : new GossipPresence((msg) => {
          lastBroadcast = sendToExchange(PRESENCE_KEY, Buffer.from(JSON.stringify(msg))).catch(() => {})
        }, typeof opts.presence === 'object' ? opts.presence : {})

  // The resilient Consumer OWNS the queue (exclusive, auto-delete) and re-declares it + its static
  // bindings after every reconnect on its own channel; requeue:false → auto-ack on handler return,
  // a throw drops (at-most-once). The only static binding is the presence key (every node always
  // wants it); per-channel binds are dynamic (below).
  const consumer = connection.createConsumer(
    {
      queue,
      queueOptions: { exclusive: true, autoDelete: true },
      exchanges: [{ exchange, type: 'direct', durable: true }],
      queueBindings: presence ? [{ exchange, routingKey: PRESENCE_KEY }] : [],
      requeue: false,
    },
    (msg) => {
      const channel = msg.routingKey
      if (presence && channel === PRESENCE_KEY) {
        try {
          presence.receive(JSON.parse((msg.body as Buffer).toString()) as PresenceMsg)
        } catch {
          // a malformed presence frame is dropped, not fatal
        }
        return
      }
      if (subscribed.has(channel)) handler?.(channel, msg.body as Buffer)
    },
  )
  consumer.on('error', () => {})

  // Reconnect survival: `ready` fires after the Consumer re-declares the queue (initial AND every
  // reconnect), so replaying the live Set here re-binds the dynamic channels against an existing
  // queue. Iterate the live Set (never a snapshot) so a concurrent unsubscribe isn't resurrected.
  consumer.on('ready', () => {
    for (const channel of subscribed) {
      void connection.queueBind({ queue, exchange, routingKey: channel })
    }
    // re-advertise our slice immediately so a node offline past livenessTtlMs isn't invisible to
    // peers until the next snapshot timer. beat() only updates local lastSeen — it doesn't broadcast.
    presence?.resnapshot()
  })
  await once(consumer, 'ready')

  return {
    connection,
    presence,
    async subscribe(channel) {
      assertKeyLen(channel)
      subscribed.add(channel)
      // strict: a bind failure surfaces to the subscriber (the lazy admin channel waits out a blip).
      await connection.queueBind({ queue, exchange, routingKey: channel })
    },
    async unsubscribe(channel) {
      subscribed.delete(channel)
      if (closed) return
      try {
        await connection.queueUnbind({ queue, exchange, routingKey: channel })
      } catch {
        // best-effort: the exclusive queue + Set reconcile make a missed unbind self-correcting.
      }
    },
    publish(channel, payload) {
      if (closed) return
      assertKeyLen(channel)
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      void sendToExchange(channel, body).catch(() => {}) // at-most-once: a lost publish is acceptable
    },
    onMessage(h) {
      handler = h
    },
    async close() {
      if (closed) return
      closed = true
      presence?.stop()
      await lastBroadcast?.catch(() => {}) // flush the graceful leave queued by clearNode before teardown
      await consumer.close().catch(() => {})
      await publisher.close().catch(() => {})
      if (ownsConnection) await connection.close().catch(() => {})
    },
  }
}
