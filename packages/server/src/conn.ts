import type { WebSocket } from 'ws'
import type { Serializer, ServerFrame, ServerMessageDef, EmitData } from '@super-line/core'

/**
 * A single client connection, passed to handlers as the third argument.
 *
 * Node-local: `conn` objects live on the node that accepted the upgrade, so don't
 * stash one to reach a user later — cross-node delivery goes through the Adapter
 * (use a per-user room instead). Generic over the events it may emit (scoped by
 * role), its `ctx`, and its `role`.
 */
export class Conn<
  Ev = Record<string, ServerMessageDef>,
  Ctx = unknown,
  Role extends string = string,
> {
  /** Namespaced channels (rooms + topics) this connection belongs to. */
  readonly channels = new Set<string>()

  constructor(
    /** The underlying `ws` socket. `conn.ws.terminate()` simulates a drop in tests. */
    readonly ws: WebSocket,
    /** This connection's role (the literal resolved by `authenticate`). */
    readonly role: Role,
    /** The context `authenticate` returned for this connection. */
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

  /** Close the underlying socket. */
  close(): void {
    this.ws.close()
  }
}
