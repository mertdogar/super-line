import type { Adapter } from '@super-line/core'
import { byteLength, extractOp, type Recorder } from './record.js'

/**
 * L2 — the Adapter seam.
 *
 * Wrapping rather than instrumenting the library keeps the measurement honest in the one way that matters:
 * every record here is written to disk, so the observer adds nothing to the traffic it observes.
 *
 * The wrapper also owns the **interest mirror**. `subscribe`/`unsubscribe` pass through here, so the lab
 * knows exactly which channels this node asked for — which is what lets the mesh tap (L3), sitting below
 * the adapter with no access to its private `subscribed` set, tell an accepted arrival from a discarded one.
 */
export interface InterestMirror {
  has(channel: string): boolean
  snapshot(): string[]
}

export function tapAdapter<A extends Adapter>(
  inner: A,
  rec: Recorder,
  decode: (payload: string | Uint8Array) => unknown,
): { adapter: A; interest: InterestMirror } {
  const subscribed = new Set<string>()

  const opOf = (payload: string | Uint8Array): number | null => {
    try {
      return extractOp(decode(payload))
    } catch {
      return null // an undecodable payload still counts as bytes; it just carries no op attribution
    }
  }

  // Spread, so the concrete adapter's extras survive the wrap — libp2p's `node` (which the mesh tap needs)
  // and the presence store (which `srv.cluster.*` needs).
  const adapter: A = {
    ...inner,
    subscribe(channel: string) {
      subscribed.add(channel)
      rec.write({ layer: 'l2', kind: 'subscribe', channel, bytes: 0 })
      return inner.subscribe(channel)
    },
    unsubscribe(channel: string) {
      subscribed.delete(channel)
      rec.write({ layer: 'l2', kind: 'unsubscribe', channel, bytes: 0 })
      return inner.unsubscribe(channel)
    },
    publish(channel: string, payload: string | Uint8Array) {
      rec.write({ layer: 'l2', kind: 'publish', channel, bytes: byteLength(payload), op: opOf(payload) })
      return inner.publish(channel, payload)
    },
    onMessage(handler: (channel: string, payload: string | Uint8Array) => void) {
      inner.onMessage((channel, payload) => {
        rec.write({ layer: 'l2', kind: 'deliver', channel, bytes: byteLength(payload), op: opOf(payload) })
        handler(channel, payload)
      })
    },
  }

  return {
    adapter,
    interest: {
      has: (channel) => subscribed.has(channel),
      snapshot: () => [...subscribed],
    },
  }
}
