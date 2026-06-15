import type { WebSocket } from 'ws'
import type { Serializer, ServerFrame, ServerMessageDef, EmitData } from '@super-line/core'

// A single client connection. Node-local: `conn` objects live on the node that
// accepted the upgrade. Cross-node delivery goes through the Adapter, not conns.
// Generic over the events it may emit (scoped by role), its ctx, and its role.
export class Conn<
  Ev = Record<string, ServerMessageDef>,
  Ctx = unknown,
  Role extends string = string,
> {
  // namespaced channels (rooms + topics) this connection belongs to, for cleanup
  readonly channels = new Set<string>()

  constructor(
    readonly ws: WebSocket,
    readonly role: Role,
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

  /** Push an event to THIS connection (node-local). Scoped to the role's events. */
  emit<E extends keyof Ev>(event: E, data: EmitData<Ev[E]>): void {
    this.send({ t: 'evt', e: String(event), d: data })
  }

  close(): void {
    this.ws.close()
  }
}
