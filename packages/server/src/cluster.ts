import type { Adapter, Serializer } from '@super-line/core'

/**
 * The field every cross-node frame carries: the id of the node that published it. One name, one home — before
 * this module the same concept was spelled `nd` on collection/CRDT frames and `i` on bus/plugin-channel frames.
 */
const NODE = 'nd'

/** An inbound cross-node frame, as {@link Cluster.receive} reports it. */
export interface ClusterMessage {
  /** The decoded frame. The {@link NODE} field is stamped in place and left visible on it. */
  data: unknown
  /**
   * The bytes exactly as they arrived. A fan-out that relays the frame on to connections unchanged can
   * `conn.sendRaw(raw)` — one pre-encoded buffer to N connections, no re-encode per recipient.
   */
  raw: string | Uint8Array
  /** The node that published it (`''` if the frame carries no id — e.g. a foreign or older publisher). */
  from: string
  /** True when *this* node published it: the Adapter loops every publish back to its own publisher. */
  own: boolean
}

/**
 * Node identity on the wire — a thin module over the {@link Adapter} that owns the one fact every cross-node
 * frame carries: which node published it. It stamps that id outbound, encodes/decodes through the
 * {@link Serializer}, and reports `own` inbound, so no call site hand-rolls `frame.nd === instanceId`.
 *
 * It owns **detection, never policy**. This server has two local-delivery strategies; both are correct, and
 * which one you picked decides what `own` means for you:
 *
 * - **deliver-at-source** — the cluster bus, plugin channels, and row-collection relay fan out to local
 *   listeners at publish time and then *drop* the looped-back copy (`if (own) return`).
 * - **deliver-on-receipt** — CRDT document relay does *not* deliver on its own store `onChange`. It publishes,
 *   and the Adapter's loopback is what fans the frame out to local subscribers. It forwards **regardless** of
 *   `own`, using `own` only to skip re-applying its own delta. A Cluster that quietly filtered own-messages
 *   would break every CRDT client's local delivery — so this one hands `own` over and stays out of it.
 *
 * The id is stamped **into** the frame rather than wrapped in an envelope, so an adapter payload remains a
 * valid client frame and the `sendRaw` passthrough above keeps working. That is why {@link NODE} appears on
 * client-visible frame types, declared there as ignored by clients.
 *
 * Distinct from the {@link Adapter} (carries the bytes; guarantees the loopback) and from a CRDT replica
 * `origin` (a per-*writer* id that survives relay, and so cannot stand in for node identity).
 */
export interface Cluster {
  /** Stamp this node's id into `frame`, encode once, and publish. The Adapter loops it back to us as well. */
  broadcast(channel: string, frame: object): void
  /** Decode an inbound payload and report who published it. `undefined` when the payload does not decode. */
  receive(payload: string | Uint8Array): ClusterMessage | undefined
}

export function createCluster(adapter: Adapter, serializer: Serializer, nodeId: string): Cluster {
  return {
    broadcast(channel, frame) {
      void adapter.publish(channel, serializer.encode({ ...frame, [NODE]: nodeId }))
    },
    receive(payload) {
      let data: unknown
      try {
        data = serializer.decode(payload)
      } catch {
        return undefined // an undecodable payload is not ours to interpret; callers drop it
      }
      const from = (data as Record<string, unknown> | null)?.[NODE]
      const id = typeof from === 'string' ? from : ''
      return { data, raw: payload, from: id, own: id !== '' && id === nodeId }
    },
  }
}
