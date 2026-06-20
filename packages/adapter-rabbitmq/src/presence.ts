import type { ConnDescriptor, NodeStat, PresenceStore } from '@super-line/core'

// Duplicated from @super-line/adapter-libp2p (adapters must not import each other). The two
// PresenceMsg wire formats never interoperate — a cluster runs a single adapter type — so this
// copy is independent. The only addition over the libp2p original is `resnapshot()`, used by the
// RabbitMQ reconnect reconcile to re-advertise this node's slice immediately after a reconnect.

type DeltaOp =
  | { k: 'set'; d: ConnDescriptor }
  | { k: 'del'; id: string }
  | { k: 'addRoom'; id: string; room: string }
  | { k: 'removeRoom'; id: string; room: string }

/** A presence message gossiped on the shared exchange's reserved presence routing key. */
export type PresenceMsg =
  | { t: 's'; n: string; q: number; ts: number; c: ConnDescriptor[] } // snapshot (authoritative)
  | { t: 'd'; n: string; q: number; op: DeltaOp } // delta (optimistic)
  | { t: 'l'; n: string } // leave (graceful clearNode)

export interface GossipPresenceOptions {
  /** How often a node re-broadcasts its full slice (anti-entropy + liveness). Default 10_000. */
  snapshotIntervalMs?: number
  /** A node not heard from within this window is treated as dead. Default 30_000. */
  livenessTtlMs?: number
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Gossip-replicated presence directory. Each node owns only its own connections
 * (single writer per slice); writes broadcast a delta and a periodic snapshot heals
 * any dropped delta. Reconcile is guarded by a monotonic per-node sequence so a stale
 * snapshot never clobbers a newer delta. Reads are local map lookups.
 */
export class GossipPresence implements PresenceStore {
  private readonly replica = new Map<string, Map<string, ConnDescriptor>>()
  private readonly appliedSeq = new Map<string, number>()
  private readonly lastSeen = new Map<string, number>()
  private selfNodeId?: string
  private selfSeq = 0
  private readonly ttl: number
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly broadcast: (msg: PresenceMsg) => void,
    opts: GossipPresenceOptions = {},
  ) {
    this.ttl = opts.livenessTtlMs ?? 30_000
    this.now = opts.now ?? ((): number => Date.now())
    this.timer = setInterval(() => this.sendSnapshot(), opts.snapshotIntervalMs ?? 10_000)
    this.timer.unref?.()
  }

  // ---- local writes (own slice) ----
  set(d: ConnDescriptor): void {
    this.selfNodeId ??= d.nodeId
    this.own().set(d.id, d)
    this.broadcast({ t: 'd', n: this.selfNodeId, q: this.bump(), op: { k: 'set', d } })
  }

  del(connId: string): void {
    if (this.selfNodeId === undefined) return
    this.own().delete(connId)
    this.broadcast({ t: 'd', n: this.selfNodeId, q: this.bump(), op: { k: 'del', id: connId } })
  }

  addRoom(connId: string, room: string): void {
    if (this.selfNodeId === undefined) return
    const d = this.own().get(connId)
    if (!d || d.rooms.includes(room)) return
    d.rooms = [...d.rooms, room]
    this.broadcast({ t: 'd', n: this.selfNodeId, q: this.bump(), op: { k: 'addRoom', id: connId, room } })
  }

  removeRoom(connId: string, room: string): void {
    if (this.selfNodeId === undefined) return
    const d = this.own().get(connId)
    if (!d || !d.rooms.includes(room)) return
    d.rooms = d.rooms.filter((r) => r !== room)
    this.broadcast({ t: 'd', n: this.selfNodeId, q: this.bump(), op: { k: 'removeRoom', id: connId, room } })
  }

  beat(nodeId: string): void {
    this.selfNodeId ??= nodeId
    this.lastSeen.set(this.selfNodeId, this.now())
  }

  clearNode(nodeId: string): void {
    this.replica.delete(nodeId)
    this.appliedSeq.delete(nodeId)
    this.lastSeen.delete(nodeId)
    if (nodeId === this.selfNodeId) this.broadcast({ t: 'l', n: nodeId })
  }

  // ---- receive (reconcile) ----
  receive(msg: PresenceMsg): void {
    if (msg.n === this.selfNodeId) return // ignore our own echo (broker loops our publish back)
    this.lastSeen.set(msg.n, this.now())
    if (msg.t === 'l') {
      this.replica.delete(msg.n)
      this.appliedSeq.delete(msg.n)
      this.lastSeen.delete(msg.n)
      return
    }
    const applied = this.appliedSeq.get(msg.n) ?? -1
    if (msg.t === 's') {
      if (msg.q < applied) return // a newer delta already landed; don't clobber
      this.replica.set(msg.n, new Map(msg.c.map((d): [string, ConnDescriptor] => [d.id, d])))
      this.appliedSeq.set(msg.n, msg.q)
      return
    }
    if (msg.q <= applied) return // stale / duplicate delta
    this.applyDelta(msg.n, msg.op)
    this.appliedSeq.set(msg.n, msg.q)
  }

  /** Re-advertise this node's slice now (used after a reconnect, before the next snapshot timer). */
  resnapshot(): void {
    this.sendSnapshot()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  // ---- reads ----
  list(): ConnDescriptor[] {
    return this.live()
  }
  get(connId: string): ConnDescriptor | undefined {
    return this.live().find((d) => d.id === connId)
  }
  byUser(userId: string): ConnDescriptor[] {
    return this.live().filter((d) => d.userId === userId)
  }
  roomMembers(room: string): ConnDescriptor[] {
    return this.live().filter((d) => d.rooms.includes(room))
  }
  count(): number {
    return this.live().length
  }
  topology(): NodeStat[] {
    const byNode = new Map<string, ConnDescriptor[]>()
    for (const d of this.live()) {
      const arr = byNode.get(d.nodeId)
      if (arr) arr.push(d)
      else byNode.set(d.nodeId, [d])
    }
    return [...byNode.entries()].map(([nodeId, ds]) => ({
      nodeId,
      nodeName: ds[0]?.nodeName ?? nodeId,
      connections: ds.length,
      rooms: new Set(ds.flatMap((d) => d.rooms)).size,
      alive: true,
    }))
  }

  // ---- internals ----
  private own(): Map<string, ConnDescriptor> {
    const id = this.selfNodeId as string
    let m = this.replica.get(id)
    if (!m) {
      m = new Map()
      this.replica.set(id, m)
    }
    return m
  }

  private bump(): number {
    this.selfSeq += 1
    this.lastSeen.set(this.selfNodeId as string, this.now())
    return this.selfSeq
  }

  private applyDelta(nodeId: string, op: DeltaOp): void {
    let slice = this.replica.get(nodeId)
    if (!slice) {
      slice = new Map()
      this.replica.set(nodeId, slice)
    }
    if (op.k === 'set') slice.set(op.d.id, op.d)
    else if (op.k === 'del') slice.delete(op.id)
    else if (op.k === 'addRoom') {
      const d = slice.get(op.id)
      if (d && !d.rooms.includes(op.room)) d.rooms = [...d.rooms, op.room]
    } else {
      const d = slice.get(op.id)
      if (d) d.rooms = d.rooms.filter((r) => r !== op.room)
    }
  }

  private sendSnapshot(): void {
    if (this.selfNodeId === undefined) return
    const slice = this.replica.get(this.selfNodeId)
    if (!slice || slice.size === 0) return // idle node stays invisible (matches the Redis adapter)
    this.broadcast({ t: 's', n: this.selfNodeId, q: this.selfSeq, ts: this.now(), c: [...slice.values()] })
  }

  private live(): ConnDescriptor[] {
    const cutoff = this.now() - this.ttl
    const out: ConnDescriptor[] = []
    for (const [nodeId, slice] of this.replica) {
      if (nodeId !== this.selfNodeId && (this.lastSeen.get(nodeId) ?? 0) < cutoff) continue
      for (const d of slice.values()) out.push(d)
    }
    return out
  }
}
