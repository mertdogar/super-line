import type { Adapter } from '@super-line/core'

// A complete, working adapter — the same seam `@super-line/adapter-redis` or
// `-libp2p` implement — except the "broker" is an object in this page. Each node
// gets ONE DemoAdapter; the bus routes every publish to every subscribed adapter.
// Severing the bus stops cross-node delivery while each node keeps delivering to
// itself (the loopback every real adapter also performs).

export class SeverableBus {
  private channels = new Map<string, Set<DemoAdapter>>()
  linked = true

  subscribe(channel: string, adapter: DemoAdapter): void {
    let set = this.channels.get(channel)
    if (!set) this.channels.set(channel, (set = new Set()))
    set.add(adapter)
  }

  unsubscribe(channel: string, adapter: DemoAdapter): void {
    const set = this.channels.get(channel)
    if (!set) return
    set.delete(adapter)
    if (!set.size) this.channels.delete(channel)
  }

  publish(channel: string, payload: string | Uint8Array, source: DemoAdapter): void {
    for (const adapter of this.channels.get(channel) ?? []) {
      if (!this.linked && adapter !== source) continue // severed: own node only
      adapter.deliver(channel, payload)
    }
  }
}

export class DemoAdapter implements Adapter {
  private handler?: (channel: string, payload: string | Uint8Array) => void
  constructor(private bus: SeverableBus) {}

  subscribe(channel: string): void {
    this.bus.subscribe(channel, this)
  }
  unsubscribe(channel: string): void {
    this.bus.unsubscribe(channel, this)
  }
  publish(channel: string, payload: string | Uint8Array): void {
    this.bus.publish(channel, payload, this)
  }
  onMessage(handler: (channel: string, payload: string | Uint8Array) => void): void {
    this.handler = handler
  }
  deliver(channel: string, payload: string | Uint8Array): void {
    this.handler?.(channel, payload)
  }
}
