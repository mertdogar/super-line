/**
 * The phase table — the single source of truth the conductor walks and each client consults to decide
 * what it does. Phases are separated by quiet gaps, so every frame is attributable to exactly one, and
 * background chatter shows up on its own during the gaps.
 *
 * The pairs are the experiment. `emit-local` vs `emit-remote` and `room-local` vs `room-spread` are the
 * same operation over different topologies: the difference between them is the cost of a publisher not
 * knowing whether any other node wants the frame.
 */
export const ROOM_LOCAL = 'local' // members: client-1a + client-1b — both on node-1
export const ROOM_SPREAD = 'spread' // members: client-1a + client-2 + client-3 — one per node
export const ROOM_CHURN = 'churn'
export const DOC_ID = 'doc-1'
export const KEEP = 'keep'
export const DROP = 'drop'

export interface PhaseSpec {
  n: number
  name: string
  detail: string
  /** Clients that act. Everyone else stays idle, so a phase measures one publisher, not four. */
  drivers: string[]
  /** How long a time-based phase holds (idle only). */
  holdMs?: number
}

export const PHASES: PhaseSpec[] = [
  {
    n: 0,
    name: 'idle',
    detail: 'zero app traffic — presence gossip and gossipsub heartbeat alone',
    drivers: [],
    holdMs: 30_000,
  },
  { n: 1, name: 'request', detail: 'request/response — should cost no cross-node frames at all', drivers: ['client-1a'] },
  {
    n: 2,
    name: 'emit-local',
    detail: 'toConn().emit to a connection on the SAME node',
    drivers: ['client-1a'],
  },
  {
    n: 3,
    name: 'emit-remote',
    detail: 'toConn().emit to a connection on ANOTHER node',
    drivers: ['client-1a'],
  },
  {
    n: 4,
    name: 'room-local',
    detail: 'room broadcast where every member is on the publishing node',
    drivers: ['client-1a'],
  },
  {
    n: 5,
    name: 'room-spread',
    detail: 'room broadcast with one member per node',
    drivers: ['client-1a'],
  },
  { n: 6, name: 'topic', detail: 'topic publish to subscribers on every node', drivers: ['client-1a'] },
  { n: 7, name: 'bus', detail: 'cluster bus — server-side subscribers only, no client fan-out', drivers: ['client-1a'] },
  { n: 8, name: 'collection', detail: 'row writes under relay replication, half leaving the subscribed filter', drivers: ['client-1a'] },
  { n: 9, name: 'crdt', detail: 'CRDT document edits on a per-document channel', drivers: ['client-1a'] },
  { n: 10, name: 'churn', detail: 'room join/leave — presence deltas, no app payload', drivers: ['client-2', 'client-3'] },
]

/** Who each phase's targeted emit addresses. Phase 2 stays on the publishing node; phase 3 crosses one hop. */
export const EMIT_TARGET: Record<number, string> = { 2: 'client-1b', 3: 'client-2' }

export const phaseByNumber = (n: number): PhaseSpec | undefined => PHASES.find((p) => p.n === n)
