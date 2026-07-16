import { validateSync } from '@super-line/core'
import type { Serializer, ServerFrame, ServerMessageDef, EmitData, RawConn, Schema } from '@super-line/core'

/**
 * A single client connection, passed to handlers as the third argument.
 *
 * Node-local: `conn` objects live on the node that accepted the connection, so don't
 * stash one to reach a user later — cross-node delivery goes through the Adapter
 * (use a per-user room instead). Generic over the events it may emit (scoped by
 * role), its `ctx`, and its `role`.
 */
export class Conn<
  Ev = Record<string, ServerMessageDef>,
  Ctx = unknown,
  Role extends string = string,
  Data = unknown,
  Env = unknown,
> {
  /** Namespaced channels (rooms + topics) this connection belongs to. */
  readonly channels = new Set<string>()
  /** Mutable per-connection scratch state, typed per role by the contract's `data` schema. */
  data: Data = {} as Data
  /**
   * Server-vended, CLIENT-VISIBLE per-connection state, typed per role by the contract's `env` schema
   * (ADR-0012). Seeded at connect (from `authenticate`'s `env`), mutated via {@link Conn.setEnv}, and
   * mirrored to the client as `client.env`. `null` when the role declares no `env`. Holds live external
   * credentials — never persisted.
   */
  env: Env = null as Env
  /** The client↔server transport (wire) this connection was accepted on (set by the server at accept). */
  transport?: string
  /** ACL identity for stores: `identify(conn) ?? conn.id`, set by the server at accept (always defined there). */
  principal?: string

  /** When this connection was accepted (`Date.now()`). */
  readonly connectedAt = Date.now()
  /** When the server last sent a heartbeat ping to this connection (managed by the server). */
  lastPingAt?: number
  /** When a heartbeat pong was last received — liveness signal (managed by the server). */
  lastPongAt?: number
  /** Pings sent since the last pong; drives reaping (managed by the server). */
  missedPongs = 0

  constructor(
    /** The underlying transport connection. `conn.terminate()` simulates a drop in tests. */
    readonly raw: RawConn,
    /** Server-assigned unique id for this connection (stable for its lifetime). */
    readonly id: string,
    /** This connection's role (the literal resolved by `authenticate`). */
    readonly role: Role,
    /** The context `authenticate` returned for this connection. */
    readonly ctx: Ctx,
    private readonly serializer: Serializer,
    /** Optional inspector tap: called with each `emit` so the server can mirror it to inspectors. */
    private readonly onEmit?: (event: string, data: unknown) => void,
    /** The role's `env` schema (ADR-0012); {@link Conn.setEnv} validates against it. Absent ⇒ no validation. */
    private readonly envSchema?: Schema,
    /** Optional inspector tap for `env.set` (called with the new env on every {@link Conn.setEnv}). */
    private readonly onSetEnv?: (env: unknown) => void,
  ) {}

  /**
   * Vend (or update) this connection's client-visible {@link Conn.env} (ADR-0012). Validates a non-null
   * value against the role's `env` schema, stores it, and pushes the full value to the client as an `env`
   * frame (last-write-wins). `null` clears it (no validation). Node-local — for a user's connections on
   * other nodes use `srv.toUser(id).setEnv(...)`.
   */
  setEnv(value: Env): void {
    if (value != null && this.envSchema) validateSync(this.envSchema, value)
    this.env = (value ?? null) as Env
    this.onSetEnv?.(this.env)
    this.send({ t: 'env', d: this.env })
  }

  /** Encode and send a frame (unicast, e.g. req/res). */
  send(frame: ServerFrame): void {
    if (!this.raw.writable) return
    this.raw.send(this.serializer.encode(frame))
  }

  /** Forward an already-encoded frame (fan-out path; encoded once at the source). */
  sendRaw(payload: string | Uint8Array): void {
    if (!this.raw.writable) return
    this.raw.send(payload)
  }

  /** Push an event to THIS connection (node-local). Scoped to the role's events. */
  emit<E extends keyof Ev>(event: E, data: EmitData<Ev[E]>): void {
    this.onEmit?.(String(event), data)
    this.send({ t: 'evt', e: String(event), d: data })
  }

  /** Graceful close of the underlying transport connection. */
  close(): void {
    this.raw.close()
  }

  /** Hard close with no handshake — used by heartbeat reaping. */
  terminate(): void {
    this.raw.terminate()
  }
}

/**
 * The ACL principal for a connection: the stable `identify` key when configured, else the
 * (random, per-connection) `conn.id`. Always returns a string — store access rules never key
 * on `undefined`. Distinct from `identify`'s raw output (which may be undefined, used for presence).
 */
export function resolvePrincipal(conn: Conn, identify?: (conn: Conn) => string | undefined): string {
  return identify?.(conn) ?? conn.id
}
