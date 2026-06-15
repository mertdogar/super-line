import type { WebSocket } from 'ws'
import type { Serializer, ServerFrame, ServerMessageDef, EmitData } from '@super-line/core'

/** Backpressure policy: what to do when a connection's send buffer grows too large. */
export interface Backpressure {
  /** Buffer size (bytes) above which {@link Backpressure.onExceed} kicks in. */
  maxBufferedBytes: number
  /** `'close'` (default) drops the connection with code 1013; `'drop'` skips the frame. */
  onExceed?: 'close' | 'drop'
}

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

  /** When this connection was accepted (`Date.now()` at the upgrade). */
  readonly connectedAt = Date.now()
  /** When the server last sent a heartbeat ping to this connection (managed by the server). */
  lastPingAt?: number
  /** When a heartbeat pong was last received — liveness signal (managed by the server). */
  lastPongAt?: number
  /** Pings sent since the last pong; drives reaping (managed by the server). */
  missedPongs = 0

  constructor(
    /** The underlying `ws` socket. `conn.ws.terminate()` simulates a drop in tests. */
    readonly ws: WebSocket,
    /** Server-assigned unique id for this connection (stable for its lifetime). */
    readonly id: string,
    /** This connection's role (the literal resolved by `authenticate`). */
    readonly role: Role,
    /** The context `authenticate` returned for this connection. */
    readonly ctx: Ctx,
    private readonly serializer: Serializer,
    private readonly backpressure?: Backpressure,
  ) {}

  // true => the frame was handled by the backpressure policy and must not be sent
  private overBackpressure(): boolean {
    const bp = this.backpressure
    if (!bp || this.ws.bufferedAmount <= bp.maxBufferedBytes) return false
    if (bp.onExceed === 'drop') {
      console.warn(`[super-line] dropping frame: conn ${this.id} over backpressure limit`)
      return true
    }
    this.ws.close(1013) // 'close' (default): too much backlog
    return true
  }

  /** Encode and send a frame (unicast, e.g. req/res). */
  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN || this.overBackpressure()) return
    this.ws.send(this.serializer.encode(frame))
  }

  /** Forward an already-encoded frame (fan-out path; encoded once at the source). */
  sendRaw(payload: string | Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN || this.overBackpressure()) return
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
