import type { PubSubLibp2p } from '@super-line/adapter-libp2p'
import { unframeChannel } from './codec.js'
import { byteLength, extractOp, type Recorder } from './record.js'
import type { InterestMirror } from './adapter-tap.js'

/**
 * L3 — the gossipsub mesh, the only layer that can see waste.
 *
 * The Adapter interface reports what a node *accepted*; it cannot report what a node was *sent*. Because
 * every super-line channel rides one shared gossipsub topic, a node receives, decrypts and decodes every
 * frame the whole cluster publishes and then drops the ones it has no local member for — inside the
 * adapter, invisible above it. This listener sits beside the adapter's own and records the arrival either
 * way, marking `accepted` from the interest mirror.
 *
 * `accepted: false` is the discarded-on-arrival term of the acceptance ratio.
 */
const PRESENCE_CHANNEL = '\x00sl:presence'

export interface MeshTapHandle {
  peerId: string
  stop: () => void
}

export function tapMesh(
  node: PubSubLibp2p,
  topic: string,
  rec: Recorder,
  interest: InterestMirror,
  decode: (payload: string | Uint8Array) => unknown,
): MeshTapHandle {
  const pubsub = node.services.pubsub
  const selfPeer = node.peerId.toString()

  const onMessage = (evt: Event): void => {
    const m = (evt as CustomEvent<{ topic: string; data: Uint8Array; type?: string; from?: { toString(): string }; sequenceNumber?: bigint }>)
      .detail
    if (m.topic !== topic) return
    const from = m.from ? m.from.toString() : 'unsigned'
    // gossipsub's own (from, seqno) is a cluster-wide message identity — it joins one publish to every
    // node that received it without the lab having to correlate on payload bytes and timing.
    const msgId = m.sequenceNumber === undefined ? `${from}:?` : `${from}:${m.sequenceNumber.toString()}`
    let channel: string
    let payload: string | Uint8Array
    try {
      ;({ channel, payload } = unframeChannel(m.data))
    } catch (err) {
      console.error('[traffic-lab] mesh tap could not decode a frame:', err)
      return
    }
    // presence rides the shared topic but never reaches the Adapter interface — the adapter consumes it
    // internally — so it is always "accepted" regardless of what the interest mirror holds.
    const accepted = channel === PRESENCE_CHANNEL ? true : interest.has(channel)
    let op: number | null = null
    try {
      op = channel === PRESENCE_CHANNEL ? null : extractOp(decode(payload))
    } catch {
      op = null
    }
    rec.write({ layer: 'l3', channel, bytes: byteLength(payload), from, msgId, accepted, op })
  }

  pubsub.addEventListener('message', onMessage)
  return { peerId: selfPeer, stop: () => pubsub.removeEventListener('message', onMessage) }
}
