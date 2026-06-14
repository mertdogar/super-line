import type { Adapter } from '@super-line/core'

// In-process pub/sub bus. Share one bus across multiple servers to simulate
// multiple nodes (each server gets its own adapter bound to the shared bus).
export class MemoryBus {
  private readonly channels = new Map<string, Set<MemoryAdapter>>()

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

class MemoryAdapter implements Adapter {
  private handler?: (channel: string, payload: string | Uint8Array) => void

  constructor(private readonly bus: MemoryBus) {}

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

export function createInMemoryAdapter(bus: MemoryBus = new MemoryBus()): Adapter {
  return new MemoryAdapter(bus)
}
