/**
 * The client↔server transport seam. A transport moves opaque encoded bytes over a
 * LOGICAL connection and hides all physical churn (reconnects, SSE's dual channel,
 * libp2p signaling). The serializer and the frame protocol stay in core, above the
 * transport — a transport never inspects a frame, it only carries bytes.
 */

/** A live logical connection, from the core's point of view. Symmetric across server + client. */
export interface RawConn {
  /** Send already-encoded bytes. A no-op when not {@link RawConn.writable}. */
  send(bytes: string | Uint8Array): void
  /** Whether a send will be accepted now (WS derives this from `readyState` + `bufferedAmount`). */
  readonly writable: boolean
  /** Register the handler for inbound frames. The transport MUST normalize each to a `Uint8Array`. */
  onMessage(cb: (bytes: Uint8Array) => void): void
  /** The logical connection died. `code` is best-effort (1000 graceful / 1006 abnormal when the transport has none). */
  onClose(cb: (code: number, reason?: string) => void): void
  /** The send buffer drained below the limit — safe to resume sending. */
  onDrain(cb: () => void): void
  /** Graceful close (close handshake when the transport has one). */
  close(code?: number, reason?: string): void
  /** Hard close with no handshake — used by heartbeat reaping. */
  terminate(): void
}

/**
 * The normalized handshake handed to `authenticate`, replacing the raw `IncomingMessage`.
 * Each transport fills what it has: ws/sse populate `headers`/`query`; libp2p/webrtc
 * populate `peer`. `raw` is the transport-specific escape hatch.
 */
export interface Handshake {
  /** Transport id, e.g. `'websocket'` | `'loopback'` | `'sse'` | `'libp2p'`. */
  transport: string
  /** Request headers (ws/sse fill these; peer transports leave them sparse). */
  headers: Record<string, string | string[] | undefined>
  /** Role + params, decoded uniformly (WS reads them from the URL query string). */
  query: Record<string, string>
  /** Peer identity, for transports that authenticate one (libp2p/webrtc). */
  peer?: { id: string; addr?: string }
  /** Escape hatch: the `IncomingMessage` for WS, the signaling payload for libp2p, etc. */
  raw: unknown
}

/**
 * What `authenticate` returns. Reject by throwing — the transport then rejects in its native idiom.
 * `transport` is injected by the server (from {@link Handshake.transport}); user `authenticate`
 * callbacks return `role` + `ctx`, and optionally `env` (the initial client-visible per-connection
 * state seeded at connect; ADR-0012). `ctx` is server-only + frozen; `env` is client-visible + mutable.
 */
export type AuthOutcome = { role: string; ctx: unknown; env?: unknown; transport?: string; connectionId?: string }

/**
 * A plugin-owned (reserved) connection class the server declares to its transports: a role name the
 * transport short-circuits `authenticate` for, plus how to recognize it. WS matches on `subprotocol`;
 * other transports may match on the {@link Handshake} via `match`. The conn is accepted with this `role`
 * and an empty ctx, then treated as observer-invisible by the core. See ADR-0005 (phase 2).
 */
export interface ReservedConnection {
  /** The reserved role assigned to a matching connection (never one of the user contract's roles). */
  role: string
  /** WebSocket subprotocol to advertise + match (browsers can set this where they can't set headers). */
  subprotocol?: string
  /** Predicate for transports without a subprotocol (SSE/libp2p): match on the normalized handshake. */
  match?: (handshake: Handshake) => boolean
}

/**
 * Server side: the transport listens, authenticates each inbound connection at its
 * native moment, and surfaces only the accepted ones — so the core never holds an
 * unauthenticated connection.
 */
export interface ServerTransport {
  start(hooks: {
    /** Core owns the decision; the transport calls this at its native auth point and rejects natively on throw. */
    authenticate: (h: Handshake) => Promise<AuthOutcome>
    /** Fires ONLY for accepted connections. */
    onConnection: (raw: RawConn, auth: AuthOutcome) => void
    /**
     * Reserved connection classes the core declares (from `inspector` + plugin connection classes). A
     * transport that supports them advertises/matches these and short-circuits `authenticate`, accepting
     * with the matched `role` and empty ctx. Transports without negotiation ignore this. See {@link ReservedConnection}.
     */
    reserved?: ReservedConnection[]
  }): void | Promise<void>
  /** Stop listening and drop in-flight connections. */
  stop(): void | Promise<void>
}

/** Client side: dial the server, encoding `handshakeParams` (role + params) in the transport's native form. */
export interface ClientTransport {
  connect(
    handshakeParams: Record<string, string>,
    hooks: {
      onOpen(): void
      onMessage(bytes: Uint8Array): void
      onClose(code: number): void
      onDrain(): void
    },
  ): RawConn
}
