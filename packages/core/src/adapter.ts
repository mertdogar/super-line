/**
 * Cross-node fan-out seam. Rooms, topics, and serverToServer all compile down to
 * channel pub/sub. A node subscribes to a channel only while it has a local member,
 * and publishes always go through the adapter (the in-memory adapter loops back),
 * so a node delivers to its local members on receipt — one code path, no double-send.
 *
 * The default is a per-server in-memory adapter; use `@super-line/adapter-redis`
 * to fan out across processes.
 */
export interface Adapter {
  /** Start receiving messages published to `channel`. */
  subscribe(channel: string): void | Promise<void>
  /** Stop receiving messages for `channel`. */
  unsubscribe(channel: string): void | Promise<void>
  /** Publish an encoded payload to `channel` (delivered to every subscribed node). */
  publish(channel: string, payload: string | Uint8Array): void | Promise<void>
  /** Register the handler invoked for each message on a subscribed channel. */
  onMessage(handler: (channel: string, payload: string | Uint8Array) => void): void
  /** Optional teardown (e.g. close Redis connections). */
  close?(): void | Promise<void>
}
