import type { RawConn, ServerTransport, ClientTransport, AuthOutcome } from '@super-line/core'

/**
 * An in-memory client↔server transport: client and server run in the same process and
 * exchange bytes directly, no socket. Mirrors the in-memory `Adapter` — a zero-dependency
 * default for tests and for proving the transport interface is not WebSocket-shaped.
 *
 * @example
 * ```ts
 * const loopback = createLoopbackTransport()
 * const srv = createSuperLineServer(contract, { transports: [loopback.server], authenticate })
 * const cl = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
 * ```
 */
export function createLoopbackTransport(): {
  server: ServerTransport
  client(): ClientTransport
} {
  let hooks: Parameters<ServerTransport['start']>[0] | undefined
  const live = new Set<Pair>()

  const server: ServerTransport = {
    start(h) {
      hooks = h
    },
    stop() {
      hooks = undefined
      // closeBoth deletes the current pair from `live`; deleting the visited element mid-iteration is safe.
      for (const pair of live) pair.closeBoth(1006)
    },
  }

  function client(): ClientTransport {
    return {
      connect(handshakeParams, clientHooks) {
        const pair = new Pair(clientHooks, live)
        const h = hooks
        if (!h) {
          // No server listening — surface an abnormal close on the next tick.
          queueMicrotask(() => pair.closeBoth(1006))
          return pair.clientEnd
        }
        h.authenticate({ transport: 'loopback', headers: {}, query: handshakeParams, raw: undefined })
          .then((auth: AuthOutcome) => {
            // closed while authenticating, or the server stopped/restarted (hooks replaced) — drop, don't open
            if (pair.done || hooks !== h) {
              pair.closeBoth(1006)
              return
            }
            pair.open(h.onConnection, auth)
          })
          .catch(() => pair.closeBoth(1006)) // rejected auth == dropped connection
        return pair.clientEnd
      },
    }
  }

  return { server, client }
}

interface ClientHooks {
  onOpen(): void
  onMessage(bytes: Uint8Array): void
  onClose(code: number): void
  onDrain(): void
}

const encoder = new TextEncoder()
const toBytes = (b: string | Uint8Array): Uint8Array => (typeof b === 'string' ? encoder.encode(b) : b)

// Two linked endpoints; one endpoint's `send` becomes the peer's `onMessage` (async, like a real wire).
class Pair {
  readonly clientEnd: Endpoint
  readonly serverEnd: Endpoint
  done = false

  constructor(
    private readonly clientHooks: ClientHooks,
    private readonly live: Set<Pair>,
  ) {
    this.clientEnd = new Endpoint(this, (b) => this.clientHooks.onMessage(b))
    this.serverEnd = new Endpoint(this)
    this.clientEnd.peer = this.serverEnd
    this.serverEnd.peer = this.clientEnd
  }

  open(onConnection: (raw: RawConn, auth: AuthOutcome) => void, auth: AuthOutcome): void {
    this.live.add(this)
    this.clientEnd.writable = true
    this.serverEnd.writable = true
    onConnection(this.serverEnd, auth) // server wires its handlers (and may emit) before the client opens
    this.clientHooks.onOpen()
  }

  closeBoth(code: number, reason?: string): void {
    if (this.done) return
    this.done = true
    this.live.delete(this)
    this.clientEnd.markClosed()
    this.serverEnd.markClosed()
    this.serverEnd.fireClose(code, reason)
    this.clientHooks.onClose(code)
  }
}

class Endpoint implements RawConn {
  writable = false
  peer!: Endpoint
  private closed = false
  private msgCb?: (bytes: Uint8Array) => void
  private closeCb?: (code: number, reason?: string) => void

  // The client endpoint delivers inbound bytes straight to the client hooks; the server
  // endpoint delivers to whatever handler `onConnection` registers.
  constructor(
    private readonly pair: Pair,
    private readonly clientDeliver?: (bytes: Uint8Array) => void,
  ) {
    this.msgCb = clientDeliver
  }

  send(bytes: string | Uint8Array): void {
    if (!this.writable) return
    const u8 = toBytes(bytes)
    queueMicrotask(() => this.peer.deliver(u8))
  }

  private deliver(bytes: Uint8Array): void {
    if (this.closed) return
    this.msgCb?.(bytes)
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason?: string) => void): void {
    this.closeCb = cb
  }
  onDrain(_cb: () => void): void {
    // loopback never buffers — drain never fires.
  }
  close(code = 1000, reason?: string): void {
    this.pair.closeBoth(code, reason)
  }
  terminate(): void {
    this.pair.closeBoth(1006)
  }

  markClosed(): void {
    this.closed = true
    this.writable = false
  }
  fireClose(code: number, reason?: string): void {
    this.closeCb?.(code, reason)
  }
}
