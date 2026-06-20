import type { Adapter, ConnDescriptor, NodeStat, PresenceStore } from '@super-line/core'

/**
 * In-process pub/sub bus. Share one bus across multiple servers to simulate
 * multiple nodes in a test (each server gets its own adapter bound to the bus).
 * The presence directory also lives here, so servers sharing a bus see the whole
 * cluster (mirroring how Redis is shared in production).
 */
export class MemoryBus {
  private readonly channels = new Map<string, Set<MemoryAdapter>>()
  // shared presence directory; in-memory liveness = "has a descriptor" (graceful del on disconnect)
  readonly descriptors = new Map<string, ConnDescriptor>()

  subscribe(channel: string, adapter: MemoryAdapter): void {
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(adapter)
  }

  unsubscribe(channel: string, adapter: MemoryAdapter): void {
    const set = this.channels.get(channel)
    if (!set) return
    set.delete(adapter)
    if (set.size === 0) this.channels.delete(channel)
  }

  publish(channel: string, payload: string | Uint8Array): void {
    const set = this.channels.get(channel)
    if (!set) return
    for (const adapter of set) adapter.deliver(channel, payload)
  }
}

class MemoryPresence implements PresenceStore {
  constructor(private readonly bus: MemoryBus) {}
  set(d: ConnDescriptor): void {
    this.bus.descriptors.set(d.id, d)
  }
  del(connId: string): void {
    this.bus.descriptors.delete(connId)
  }
  beat(): void {
    // no-op: in-memory liveness is graceful del, not TTL
  }
  clearNode(nodeId: string): void {
    for (const [id, d] of this.bus.descriptors) if (d.nodeId === nodeId) this.bus.descriptors.delete(id)
  }
  addRoom(connId: string, room: string): void {
    const d = this.bus.descriptors.get(connId)
    if (d && !d.rooms.includes(room)) d.rooms = [...d.rooms, room]
  }
  removeRoom(connId: string, room: string): void {
    const d = this.bus.descriptors.get(connId)
    if (d) d.rooms = d.rooms.filter((r) => r !== room)
  }
  list(): ConnDescriptor[] {
    return [...this.bus.descriptors.values()]
  }
  get(connId: string): ConnDescriptor | undefined {
    return this.bus.descriptors.get(connId)
  }
  byUser(userId: string): ConnDescriptor[] {
    return this.list().filter((d) => d.userId === userId)
  }
  roomMembers(room: string): ConnDescriptor[] {
    return this.list().filter((d) => d.rooms.includes(room))
  }
  count(): number {
    return this.bus.descriptors.size
  }
  topology(): NodeStat[] {
    const byNode = new Map<string, ConnDescriptor[]>()
    for (const d of this.list()) {
      const set = byNode.get(d.nodeId)
      if (set) set.push(d)
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
}

class MemoryAdapter implements Adapter {
  private handler?: (channel: string, payload: string | Uint8Array) => void
  readonly presence: PresenceStore

  constructor(private readonly bus: MemoryBus) {
    this.presence = new MemoryPresence(bus)
  }

  subscribe(channel: string): void {
    this.bus.subscribe(channel, this)
  }
  unsubscribe(channel: string): void {
    this.bus.unsubscribe(channel, this)
  }
  publish(channel: string, payload: string | Uint8Array): void {
    this.bus.publish(channel, payload)
  }
  onMessage(handler: (channel: string, payload: string | Uint8Array) => void): void {
    this.handler = handler
  }
  deliver(channel: string, payload: string | Uint8Array): void {
    this.handler?.(channel, payload)
  }
}

/**
 * Create an in-memory {@link Adapter}. The default for a single-node server.
 * Pass a shared {@link MemoryBus} to two servers to simulate cross-node fan-out.
 */
export function createInMemoryAdapter(bus: MemoryBus = new MemoryBus()): Adapter {
  return new MemoryAdapter(bus)
}
