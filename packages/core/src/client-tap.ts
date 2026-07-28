/**
 * The client's observation vocabulary (ADR-0024) — the mirror of the server's {@link TapEvent},
 * deliberately NOT the same union.
 *
 * The server's taxonomy is written in terms a client does not possess (`connId`, `role`, `target`,
 * `nodeId`). And the things worth watching on a client are mostly the ones that never reach the
 * wire: a request created but never sent, a delivery that found no listener, a row change a
 * subscription re-filtered away, a reconnect still counting down. So this union is two kinds —
 * the wire frame verbatim, plus the decisions the wire cannot show.
 *
 * Correlation is deliberately absent. Pairing a response to its request and timing it are things a
 * READER does; performing them here would mean the client holding per-request state purely so it
 * could be observed.
 */

import type { Frame } from './wire.js'

/** Which side of the wire a frame crossed, from the client's point of view. */
export type FrameDirection = 'out' | 'in'

/**
 * Why a tracked request ended without a response. `timeout` is the client's own deadline expiring;
 * `disconnected` is the socket dying under an in-flight call.
 */
export type RequestDropReason = 'timeout' | 'disconnected'

/**
 * What a connection's transport just did. `retry` carries the backoff the client is about to wait —
 * invisible on the wire by definition, since nothing is being sent.
 */
export type ConnPhase = 'open' | 'close' | 'retry'

/**
 * Where an inbound row change landed for ONE subscription. The server delivers a change when the row
 * crosses a connection's visibility; the client then re-filters per subscription, and that decision
 * is unreconstructable from the wire — the same `cchg` frame legitimately produces a different
 * outcome for every live subscription on the collection.
 *
 * `left-filter` is the interesting one: the row still exists, it simply no longer matches THIS
 * subscription's query, so it is removed here while remaining present elsewhere.
 */
export type RouteDecision =
  | 'insert'
  | 'update'
  | 'left-filter'
  | 'delete'
  | 'skip'
  | 'buffered'

// Note there is deliberately no "was this an echo of our own write" variant: the writer origin rides
// on the frame itself, and so does every origin this client ever sent, which makes echo-detection a
// fold the reader can do. Holding a set of our own origins purely so an observer could read it back
// would be the client keeping state for the observer's benefit.

/**
 * One observation from a client. Emitted synchronously at the site it describes, with LIVE payload
 * references — an observer must not mutate them, and must snapshot anything it intends to keep.
 */
export type ClientTapEvent =
  /** A frame crossed the wire. `bytes` is its encoded size. */
  | { k: 'frame'; dir: FrameDirection; f: Frame; bytes: number }
  /** A request was created but not sent — the socket was not writable. It will go out on reconnect. */
  | { k: 'req.queued'; i: number; m: string }
  /** A tracked request ended with no response. */
  | { k: 'req.dropped'; i: number; m: string; why: RequestDropReason }
  /** An inbound event or topic payload was dispatched. `listeners: 0` is a silent bug with no server-side symptom. */
  | { k: 'deliver'; kind: 'event' | 'topic'; name: string; listeners: number }
  /** An inbound payload failed contract validation and was dropped (only under `validate: 'inbound'`). */
  | { k: 'validate.fail'; kind: 'response' | 'event' | 'topic'; name: string; message: string }
  /** An inbound row change was routed into one subscription. Fires once PER live subscription on the collection. */
  | { k: 'route'; n: string; sid: number; id: string; decision: RouteDecision }
  /** The transport opened, closed, or scheduled a retry. */
  | { k: 'conn'; phase: ConnPhase; code?: number; attempt?: number; delayMs?: number }
  /**
   * An inbound CRDT delta was dispatched to the local replicas of one document. `replicas: 0` means
   * the delta arrived for a document this client does not have open and was dropped — invisible on
   * the wire, and the usual explanation for "my document stopped updating".
   */
  | { k: 'doc'; n: string; id: string; replicas: number }

/**
 * Cross-cutting metadata wrapping one {@link ClientTapEvent} — the counterpart of the server's
 * `InspectorEnvelope`. The event stays a pure "what happened"; the envelope carries when, which
 * client, and where in the stream.
 *
 * `seq` is assigned by the CONSUMER, not the client, because it must be monotonic across every
 * client on the page — and a page runs several (a session replacement deliberately runs the
 * incumbent and its candidate at the same time). It is what lets a consumer reading through two
 * channels at once dedup and detect gaps.
 */
export interface ClientTapRecord {
  /** The observation, with payloads snapshotted by the consumer. */
  event: ClientTapEvent
  /** Monotonic across all clients on the page; assigned at buffer time. */
  seq: number
  /** Emit time (epoch ms). */
  ts: number
  /** Which client on the page emitted it. */
  clientId: string
}
