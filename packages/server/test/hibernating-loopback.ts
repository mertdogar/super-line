import type { AuthOutcome, ClientTransport, ConnectionSnapshot, RawConn, ServerTransport } from '@super-line/core'

// A loopback whose server-side sockets OUTLIVE the server instance, the way a Durable Object's sockets
// outlive a hibernation. `evict()` makes the current server's teardown leave every socket open and fire
// nothing; a server started afterwards on the same transport is handed each surviving socket through
// `adoptConnection`, with the snapshot this transport persisted (JSON round-tripped, as DO SQLite would).

type StartHooks = Parameters<ServerTransport['start']>[0]
interface ClientHooks {
  onOpen(): void
  onMessage(bytes: Uint8Array): void
  onClose(code: number): void
  onDrain(): void
}
const enc = new TextEncoder()

class End implements RawConn {
  writable = false // until the server accepted
  peer!: End
  closed = false
  evicting = false
  msgCb?: (b: Uint8Array) => void
  closeCb?: (code: number, reason?: string) => void
  constructor(private readonly onClosed: () => void) {}
  send(bytes: string | Uint8Array): void {
    if (!this.writable) return
    const u8 = typeof bytes === 'string' ? enc.encode(bytes) : bytes
    queueMicrotask(() => {
      if (!this.peer.closed) this.peer.msgCb?.(u8)
    })
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason?: string) => void): void {
    this.closeCb = cb
  }
  onDrain(): void {}
  close(code = 1000, reason?: string): void {
    if (this.evicting) return // the server is going away; the socket is not
    for (const e of [this, this.peer]) {
      e.closed = true
      e.writable = false
    }
    this.closeCb?.(code, reason)
    this.peer.closeCb?.(code, reason)
    this.onClosed()
  }
  terminate(): void {
    this.close(1006)
  }
}

export function hibernatingLoopback() {
  let hooks: StartHooks | undefined
  const sockets = new Map<string, End>() // connection id → server end
  const snapshots = new Map<string, string>() // connection id → persisted JSON
  const holds: number[] = []

  const server: ServerTransport = {
    liveness: 'socket',
    start(h) {
      hooks = h
    },
    stop() {
      hooks = undefined
    },
    onSnapshotChanged(connId, snapshot) {
      snapshots.set(connId, JSON.stringify(snapshot))
    },
    onHold(count) {
      holds.push(count)
    },
  }

  function client(): ClientTransport {
    return {
      connect(params, ch: ClientHooks) {
        const h = hooks
        let connId = ''
        const serverEnd = new End(() => {
          sockets.delete(connId)
          snapshots.delete(connId)
        })
        const clientEnd = new End(() => {})
        clientEnd.peer = serverEnd
        serverEnd.peer = clientEnd
        clientEnd.msgCb = (b) => ch.onMessage(b)
        clientEnd.closeCb = (code) => ch.onClose(code)
        if (!h) {
          queueMicrotask(() => clientEnd.close(1006))
          return clientEnd
        }
        void h
          .authenticate({ transport: 'hib-loopback', headers: {}, query: params, raw: undefined })
          .then((auth: AuthOutcome) => {
            connId = auth.connectionId ?? crypto.randomUUID() // the transport tags the socket, so it names the id
            sockets.set(connId, serverEnd)
            serverEnd.writable = clientEnd.writable = true
            h.onConnection(serverEnd, { ...auth, connectionId: connId })
            ch.onOpen()
          })
          .catch(() => clientEnd.close(1006))
        return clientEnd
      },
    }
  }

  return {
    server,
    client,
    holds,
    /** Every live socket survives the next server teardown, silently. */
    evict() {
      for (const s of sockets.values()) s.evicting = true
    },
    /** Hand every surviving socket to the server started since `evict()`. */
    wake() {
      if (!hooks?.adoptConnection) throw new Error('no server with adoptConnection is listening')
      for (const [id, s] of sockets) {
        s.evicting = false
        s.msgCb = undefined
        s.closeCb = undefined
        hooks.adoptConnection(s, JSON.parse(snapshots.get(id)!) as ConnectionSnapshot)
      }
    },
    /** Every live socket stops delivering to the server, which so never answers again (a dead peer). */
    silence() {
      for (const s of sockets.values()) s.msgCb = () => {}
    },
    snapshot(connId: string): ConnectionSnapshot | undefined {
      const json = snapshots.get(connId)
      return json === undefined ? undefined : (JSON.parse(json) as ConnectionSnapshot)
    },
    connectionIds: () => [...sockets.keys()],
  }
}
