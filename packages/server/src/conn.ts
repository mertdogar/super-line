import type { WebSocket } from 'ws'
import type { Serializer, ServerFrame } from '@super-line/core'

// A single client connection. Node-local: `conn` objects live on the node that
// accepted the upgrade. Cross-node delivery goes through the Adapter, not conns.
export class Conn<Ctx = unknown> {
  // namespaced channels (rooms + topics) this connection belongs to, for cleanup
  readonly channels = new Set<string>()

  constructor(
    readonly ws: WebSocket,
    readonly ctx: Ctx,
    private readonly serializer: Serializer,
  ) {}

  /** Encode and send a frame (unicast, e.g. req/res). */
  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(this.serializer.encode(frame))
  }

  /** Forward an already-encoded frame (fan-out path; encoded once at the source). */
  sendRaw(payload: string | Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(payload)
  }

  emit(event: string, data: unknown): void {
    this.send({ t: 'evt', e: event, d: data })
  }

  close(): void {
    this.ws.close()
  }
}
