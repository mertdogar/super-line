import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Connection } from 'rabbitmq-client'
import type { Adapter } from '@super-line/core'

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
}

const DEFAULT_EXCHANGE = 'super-line'
const DEFAULT_QUEUE_PREFIX = 'sl.node'
const MAX_ROUTING_KEY_BYTES = 255

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

  // The `subscribed` Set is the desired-state source of truth, replayed on every (re)connect.
  const subscribed = new Set<string>()
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined
  let closed = false

  // The resilient Consumer OWNS the queue (exclusive, auto-delete) and re-declares it after every
  // reconnect on its own channel; requeue:false → auto-ack on handler return, a throw drops
  // (at-most-once). It carries no static channel bindings — those are all dynamic (below).
  const consumer = connection.createConsumer(
    {
      queue,
      queueOptions: { exclusive: true, autoDelete: true },
      exchanges: [{ exchange, type: 'direct', durable: true }],
      requeue: false,
    },
    (msg) => {
      const channel = msg.routingKey
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
  })
  await once(consumer, 'ready')

  return {
    connection,
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
      void publisher
        .send({ exchange, routingKey: channel, contentType: 'application/octet-stream' }, body)
        .catch(() => {}) // at-most-once: a publish lost during a blip is acceptable
    },
    onMessage(h) {
      handler = h
    },
    async close() {
      if (closed) return
      closed = true
      await consumer.close().catch(() => {})
      await publisher.close().catch(() => {})
      if (ownsConnection) await connection.close().catch(() => {})
    },
  }
}
