import { channelClass } from '../tap/codec.js'
import { PHASES } from '../phases.js'
import type { LabRecord } from '../tap/record.js'
import type { RunData } from './load.js'
import { classifyArrival, classifyPublish, type Verdict } from './verdict.js'

export interface Tally {
  count: number
  bytes: number
}
const zero = (): Tally => ({ count: 0, bytes: 0 })
const add = (t: Tally, bytes: number): void => {
  t.count++
  t.bytes += bytes
}
const bump = <K extends string>(m: Map<K, Tally>, k: K, bytes: number): void => {
  const t = m.get(k) ?? zero()
  add(t, bytes)
  m.set(k, t)
}

export interface PhaseMetrics {
  n: number
  name: string
  ops: number
  publishes: number
  publishBytes: number
  /** What the Adapter handed to this node's runtime. Comparable ACROSS adapters — a broker and a mesh
   *  deliver the same useful frames; only the mesh also transports the ones nobody wanted. */
  delivers: number
  arrivals: number
  accepted: number
  discarded: number
  arrivalBytes: number
  /** Publishes whose every remote node discarded them — the wire hop bought nothing. */
  wastedPublishes: number
}

export interface NodeMetrics {
  node: string
  arrivals: number
  accepted: number
  /** accepted ÷ arrivals — the headline. 1.0 means the node was sent only what it wanted. */
  acceptanceRatio: number
  nicRx: number
  nicTx: number
  attributedBytes: number
}

export interface ClientMetrics {
  framesIn: number
  framesOut: number
  bytesIn: number
  bytesOut: number
  /** A row change delivered, then dropped by the subscription's own filter (permissive routing, by design). */
  leftFilter: number
  /** An event or topic payload that reached no listener at all. */
  zeroListener: number
  /** A CRDT delta for a document this client does not have open. */
  zeroReplica: number
}

export interface RunMetrics {
  runId: string
  adapter: string
  inspector: boolean
  phases: PhaseMetrics[]
  channels: Array<{ channel: string; arrivals: Tally; accepted: number }>
  arrivalVerdicts: Map<Verdict, Tally>
  arrivalKinds: Map<string, Tally>
  publishVerdicts: Map<Verdict, Tally>
  publishKinds: Map<string, Tally>
  nodes: NodeMetrics[]
  client: ClientMetrics
  totals: { publishes: Tally; delivers: Tally; arrivals: Tally; accepted: number }
}

const isL3 = (r: LabRecord): r is LabRecord & { layer: 'l3' } => r.layer === 'l3'
const isL2 = (r: LabRecord): r is LabRecord & { layer: 'l2' } => r.layer === 'l2'

export function computeMetrics(run: RunData): RunMetrics {
  const phases = new Map<number, PhaseMetrics>()
  for (const p of PHASES)
    phases.set(p.n, {
      n: p.n,
      name: p.name,
      ops: 0,
      publishes: 0,
      publishBytes: 0,
      delivers: 0,
      arrivals: 0,
      accepted: 0,
      discarded: 0,
      arrivalBytes: 0,
      wastedPublishes: 0,
    })
  const phaseOf = (n: number | null): PhaseMetrics | undefined => (n === null ? undefined : phases.get(n))

  // Where a publishing node delivered the frame to its OWN members. Under libp2p the adapter loops back
  // synchronously when subscribed, so a `deliver` on the publisher is exactly "local members existed".
  const localDelivery = new Set<string>()
  for (const [actor, records] of run.byActor)
    for (const r of records)
      if (isL2(r) && r.kind === 'deliver') localDelivery.add(`${actor}|${r.channel}|${r.op ?? `p${r.phase}`}`)

  const channels = new Map<string, Tally>()
  const channelAccepted = new Map<string, number>()
  const arrivalVerdicts = new Map<Verdict, Tally>()
  const arrivalKinds = new Map<string, Tally>()
  const publishVerdicts = new Map<Verdict, Tally>()
  const publishKinds = new Map<string, Tally>()
  const totals = { publishes: zero(), delivers: zero(), arrivals: zero(), accepted: 0 }

  // One gossipsub (peer, seqno) is one publish seen from every node that received it — an exact
  // cluster-wide join key that needs no correlation on payload bytes or timing.
  interface Group {
    channel: string
    bytes: number
    phase: number | null
    op: number | null
    from: string
    accepted: number
    receivers: number
  }
  const groups = new Map<string, Group>()

  const nodes: NodeMetrics[] = []
  for (const node of run.nodes) {
    const records = run.byActor.get(node) ?? []
    let arrivals = 0
    let accepted = 0
    let attributed = 0
    const nic = records.filter((r): r is LabRecord & { layer: 'nic' } => r.layer === 'nic')
    for (const r of records) {
      if (isL2(r)) {
        if (r.kind === 'deliver') {
          add(totals.delivers, r.bytes)
          const dm = phaseOf(r.phase)
          if (dm) dm.delivers++
        }
        if (r.kind === 'publish') {
          add(totals.publishes, r.bytes)
          attributed += r.bytes
          const pm = phaseOf(r.phase)
          if (pm) {
            pm.publishes++
            pm.publishBytes += r.bytes
          }
        }
        continue
      }
      if (!isL3(r)) continue
      arrivals++
      attributed += r.bytes
      if (r.accepted) accepted++
      add(totals.arrivals, r.bytes)
      if (r.accepted) totals.accepted++
      bump(channels, channelClass(r.channel), r.bytes)
      if (r.accepted) channelAccepted.set(channelClass(r.channel), (channelAccepted.get(channelClass(r.channel)) ?? 0) + 1)

      const c = classifyArrival(r.channel, r.accepted)
      bump(arrivalVerdicts, c.verdict, r.bytes)
      bump(arrivalKinds, `${c.verdict}:${c.kind}`, r.bytes)

      const pm = phaseOf(r.phase)
      if (pm) {
        pm.arrivals++
        pm.arrivalBytes += r.bytes
        if (r.accepted) pm.accepted++
        else pm.discarded++
      }

      const g = groups.get(r.msgId) ?? {
        channel: r.channel,
        bytes: r.bytes,
        phase: r.phase,
        op: r.op,
        from: r.from,
        accepted: 0,
        receivers: 0,
      }
      g.receivers++
      if (r.accepted) g.accepted++
      groups.set(r.msgId, g)
    }
    const first = nic[0]
    const last = nic[nic.length - 1]
    nodes.push({
      node,
      arrivals,
      accepted,
      acceptanceRatio: arrivals === 0 ? 1 : accepted / arrivals,
      nicRx: first && last ? last.rx - first.rx : -1,
      nicTx: first && last ? last.tx - first.tx : -1,
      attributedBytes: attributed,
    })
  }

  // Publisher-side verdicts, from the receivers' view of each publish.
  for (const g of groups.values()) {
    const publisher = run.peerToNode.get(g.from)
    const key = publisher ? `${publisher}|${g.channel}|${g.op ?? `p${g.phase}`}` : ''
    const c = classifyPublish(g.channel, g.accepted, localDelivery.has(key))
    bump(publishVerdicts, c.verdict, g.bytes)
    bump(publishKinds, `${c.verdict}:${c.kind}`, g.bytes)
    if (c.verdict === 'waste') {
      const pm = phaseOf(g.phase)
      if (pm) pm.wastedPublishes++
    }
  }

  // Client-side: the wire, plus the drops that never reach it (ADR-0024).
  const client: ClientMetrics = {
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    leftFilter: 0,
    zeroListener: 0,
    zeroReplica: 0,
  }
  for (const actor of run.clients) {
    for (const r of run.byActor.get(actor) ?? []) {
      if (r.layer !== 'l5') continue
      const e = r.event
      if (e.k === 'frame') {
        if (e.dir === 'in') {
          client.framesIn++
          client.bytesIn += e.bytes
        } else {
          client.framesOut++
          client.bytesOut += e.bytes
        }
      } else if (e.k === 'route' && (e.decision === 'left-filter' || e.decision === 'skip')) client.leftFilter++
      else if (e.k === 'deliver' && e.listeners === 0) client.zeroListener++
      else if (e.k === 'doc' && e.replicas === 0) client.zeroReplica++
    }
    // Ops are counted from the driver's outbound frames — what the workload actually asked for. Collection
    // batches and CRDT writes are their own frame types, not requests, so counting `req` alone reports zero
    // for exactly the two phases whose traffic is heaviest.
    for (const r of run.byActor.get(actor) ?? []) {
      if (r.layer !== 'l5' || r.event.k !== 'frame' || r.event.dir !== 'out') continue
      const f = r.event.f as { t?: string }
      if (f.t !== 'req' && f.t !== 'cbat' && f.t !== 'cdwr') continue
      const pm = phaseOf(r.phase)
      if (pm) pm.ops++
    }
  }

  return {
    runId: run.runId,
    adapter: run.adapter,
    inspector: run.inspector,
    phases: [...phases.values()],
    channels: [...channels.entries()]
      .map(([channel, arrivals]) => ({ channel, arrivals, accepted: channelAccepted.get(channel) ?? 0 }))
      .sort((a, b) => b.arrivals.count - a.arrivals.count),
    arrivalVerdicts,
    arrivalKinds,
    publishVerdicts,
    publishKinds,
    nodes,
    client,
    totals,
  }
}
