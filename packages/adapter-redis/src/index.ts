import { Redis } from 'ioredis'
import type { Adapter } from '@super-line/core'

export interface RedisAdapterOptions {
  /** redis:// connection URL. */
  url?: string
}

// Redis Pub/Sub adapter. Uses two connections (a subscriber connection cannot run
// other commands). At-most-once fan-out, matching the library's delivery model.
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
