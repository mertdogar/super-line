import { Redis } from 'ioredis'
import type { Adapter } from '@super-line/core'

/** Options for {@link createRedisAdapter}. */
export interface RedisAdapterOptions {
  /** `redis://` connection URL (defaults to ioredis's default localhost:6379). */
  url?: string
}

/**
 * Create a Redis Pub/Sub {@link Adapter} for multi-node fan-out. Pass the same
 * URL to every server process so rooms, topics, and serverToServer events reach
 * clients on any node. Uses two connections (a subscriber connection can't run
 * other commands); at-most-once delivery, matching the library's model.
 *
 * @param options - a `redis://` URL string or {@link RedisAdapterOptions}.
 * @example
 * ```ts
 * createSocketServer(api, { server, adapter: createRedisAdapter('redis://localhost:6379') })
 * ```
 */
export function createRedisAdapter(options: RedisAdapterOptions | string = {}): Adapter {
  const url = typeof options === 'string' ? options : options.url
  const pub = url ? new Redis(url) : new Redis()
  // ready-check runs INFO, which is illegal once a connection enters subscriber mode;
  // disable it on the subscriber connection.
  const sub = pub.duplicate({ enableReadyCheck: false })
  // ioredis auto-reconnects; swallow transient 'error' events so they don't crash the process
  pub.on('error', () => {})
  sub.on('error', () => {})
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined

  let closed = false

  // messageBuffer carries the raw bytes, preserving binary serializer output
  sub.on('messageBuffer', (channel: Buffer, payload: Buffer) => {
    handler?.(channel.toString(), payload)
  })

  return {
    async subscribe(channel) {
      await sub.subscribe(channel) // strict: failures surface to the subscribing client
    },
    async unsubscribe(channel) {
      if (closed) return
      try {
        await sub.unsubscribe(channel)
      } catch {
        // shutting down / disconnected — unsubscribe is best-effort
      }
    },
    async publish(channel, payload) {
      if (closed) return
      const message = typeof payload === 'string' ? payload : Buffer.from(payload)
      try {
        await pub.publish(channel, message)
      } catch {
        // at-most-once: a publish lost during a blip is acceptable
      }
    },
    onMessage(h) {
      handler = h
    },
    async close() {
      closed = true
      await Promise.allSettled([pub.quit(), sub.quit()])
    },
  }
}
