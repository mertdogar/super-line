// Cross-node fan-out seam. Rooms and topics both compile down to channel pub/sub.
// A node subscribes to a channel only while it has at least one local member, and
// publishes always go through the adapter (the in-memory adapter loops back), so a
// node delivers to its LOCAL members on receipt — one code path, no double-send.
export interface Adapter {
  subscribe(channel: string): void | Promise<void>
  unsubscribe(channel: string): void | Promise<void>
  publish(channel: string, payload: string | Uint8Array): void | Promise<void>
  onMessage(handler: (channel: string, payload: string | Uint8Array) => void): void
  close?(): void | Promise<void>
}
