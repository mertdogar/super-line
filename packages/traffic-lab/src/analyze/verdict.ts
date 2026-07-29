import { channelClass } from '../tap/codec.js'

/**
 * The delivery verdict (CONTEXT.md): what one cross-node arrival was worth.
 *
 * The point of four buckets rather than a bare waste/necessary split is that super-line over-delivers on
 * purpose in places, and a measurement that cannot tell deliberate cost from accident would read as an
 * indictment of decisions that were taken with their eyes open.
 */
export type Verdict = 'useful' | 'waste' | 'by-design' | 'observation'

export interface Classified {
  verdict: Verdict
  /** The specific mechanism, for the report's breakdown. */
  kind: string
}

const PRESENCE = '\x00sl:presence'

/** Classify one arrival on a node that did not publish it. */
export function classifyArrival(channel: string, accepted: boolean): Classified {
  if (channel === PRESENCE) return { verdict: 'by-design', kind: 'presence-gossip' }
  if (channel.startsWith('x:inspector')) return { verdict: 'observation', kind: 'inspector-feed' }
  if (!accepted) return { verdict: 'waste', kind: 'discarded-on-arrival' }
  if (channel === 'cbatch') return { verdict: 'by-design', kind: 'relay-replication' }
  return { verdict: 'useful', kind: channelClass(channel) }
}

/**
 * Classify one PUBLISH, judged by what the cluster did with it. This is the publisher-side counterpart of
 * `discarded-on-arrival`: the same event, seen from the end that could have avoided it.
 *
 * `locally-satisfiable` is the sharpest finding the lab can produce — every interested member was already
 * on the publishing node, so the wire hop bought nothing at all.
 */
export function classifyPublish(
  channel: string,
  remoteAccepted: number,
  publisherDeliveredLocally: boolean,
): Classified {
  if (channel === PRESENCE) return { verdict: 'by-design', kind: 'presence-gossip' }
  if (channel.startsWith('x:inspector')) return { verdict: 'observation', kind: 'inspector-feed' }
  if (remoteAccepted > 0) return { verdict: 'useful', kind: channelClass(channel) }
  if (publisherDeliveredLocally) return { verdict: 'waste', kind: 'locally-satisfiable' }
  return { verdict: 'waste', kind: 'cluster-zero-interest' }
}

export const VERDICT_ORDER: Verdict[] = ['useful', 'by-design', 'observation', 'waste']
