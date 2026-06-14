import type { WebSocket } from 'ws'
import type { Serializer, ServerFrame } from '@super-line/core'

// A single client connection. Node-local: `conn` objects live on the node that
// accepted the upgrade. Cross-node delivery goes through the Adapter, not conns.
export class Conn<Ctx = unknown> {
  readonly subscriptions = new Set<string>()
  readonly rooms = new Set<string>()

  constructor(
    readonly ws: WebSocket,
    readonly ctx: Ctx,
    private readonly serializer: Serializer,
  ) {}

  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(this.serializer.encode(frame))
  }

  emit(event: string, data: unknown): void {
    this.send({ t: 'evt', e: event, d: data })
  }

  close(): void {
    this.ws.close()
  }
}
