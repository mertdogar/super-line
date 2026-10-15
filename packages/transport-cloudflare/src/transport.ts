import { getLogger } from '@logtape/logtape'
import type { AuthOutcome, ConnectionSnapshot, Handshake, RawConn, ReservedConnection, ServerTransport } from '@super-line/core'

const log = getLogger(['super-line', 'transport-cloudflare'])

/** Closes a socket whose connection could not be resumed on wake; the client reconnects on it like any drop. */
export const CLOSE_NOT_RESUMABLE = 4409

/**
 * The transport a Durable Object hosts: a {@link ServerTransport} plus the handlers the object forwards from
 * its own `fetch` and `webSocket*` methods. {@link createDurableNode} does that forwarding for you.
 */
export interface CloudflareServerTransport extends ServerTransport {
  /** Accept a WebSocket upgrade (any other request gets a 426). */
  fetch(request: Request): Promise<Response>
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void
  webSocketClose(ws: WebSocket, code: number, reason: string): void
  webSocketError(ws: WebSocket, error: unknown): void
}

type Hooks = Parameters<ServerTransport['start']>[0]

const SNAPSHOTS = '_sl_conn'
const encoder = new TextEncoder()

/**
 * A super-line transport over the Durable Object WebSocket Hibernation API. Sockets are accepted with
 * `ctx.acceptWebSocket`, so the object can hibernate while they stay open; each connection's snapshot is kept in
 * the object's SQLite storage (the object must be a SQLite-backed class). When the object wakes, the server's
 * `ready` resolves only after every surviving socket is back with its subscriptions (one that cannot be resumed is
 * closed 4409) — await it inside `blockConcurrencyWhile` so no event lands before then. Liveness is the socket's:
 * client pings are answered by the platform without waking the object, so the server runs no heartbeat.
 */
export function cloudflareServerTransport(ctx: DurableObjectState): CloudflareServerTransport {
  let hooks: Hooks | undefined
  const conns = new Map<WebSocket, DurableConn>()
  const sql = ctx.storage.sql
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOTS} (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`)
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))

  const forget = (ws: WebSocket, id: string): void => {
    conns.delete(ws)
    sql.exec(`DELETE FROM ${SNAPSHOTS} WHERE id = ?`, id)
  }

  function adopt(ws: WebSocket, id: string): DurableConn {
    const conn = new DurableConn(ws, id, () => forget(ws, id))
    conns.set(ws, conn)
    return conn
  }

  // Busy tokens: a pending timer is what keeps a Durable Object out of hibernation (`waitUntil` does nothing there).
  let busy: ReturnType<typeof setInterval> | undefined

  async function fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
    if (!hooks) return new Response('Not started', { status: 503 })
    const handshake = buildHandshake(request)
    const reserved = reservedFor(hooks.reserved ?? [], request, handshake)
    let auth: AuthOutcome
    if (reserved) {
      try {
        auth = { role: reserved.role, ctx: (await reserved.authenticate?.(handshake)) ?? {} }
      } catch (err) {
        // Not a 401: a refused upgrade reaches a browser as a bare 1006, indistinguishable from a dead host.
        log.warn('reserved connection rejected for role={role} {error}', { role: reserved.role, error: err })
        return refuseAfterUpgrade(reserved.subprotocol, err)
      }
    } else {
      try {
        auth = await hooks.authenticate(handshake)
      } catch (err) {
        log.warn('authenticate threw — rejecting connection with 401 {error}', { error: err })
        return new Response('Unauthorized', { status: 401 })
      }
    }
    const id = auth.connectionId ?? crypto.randomUUID() // the transport tags the socket, so it names the connection
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    ctx.acceptWebSocket(server, [id])
    server.serializeAttachment({ id })
    hooks.onConnection(adopt(server, id), { ...auth, connectionId: id })
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(reserved?.subprotocol ? { headers: { 'Sec-WebSocket-Protocol': reserved.subprotocol } } : {}),
    })
  }

  async function resume(): Promise<void> {
    const adoptConnection = hooks?.adoptConnection
    const live = new Set<string>()
    for (const ws of ctx.getWebSockets()) {
      const id = (ws.deserializeAttachment() as { id?: string } | null)?.id
      const row = id ? sql.exec<{ snapshot: string }>(`SELECT snapshot FROM ${SNAPSHOTS} WHERE id = ?`, id).toArray()[0] : undefined
      if (!id || !row || !adoptConnection) {
        ws.close(CLOSE_NOT_RESUMABLE, 'connection could not be resumed')
        continue
      }
      live.add(id)
      try {
        await adoptConnection(adopt(ws, id), JSON.parse(row.snapshot) as ConnectionSnapshot)
      } catch (err) {
        log.error('resuming connection {id} failed {error}', { id, error: err })
        conns.delete(ws)
        ws.close(CLOSE_NOT_RESUMABLE, 'connection could not be resumed')
      }
    }
    // a snapshot whose socket is gone (a deploy drops every socket without a close event) has nothing to resume
    for (const { id } of sql.exec<{ id: string }>(`SELECT id FROM ${SNAPSHOTS}`).toArray())
      if (!live.has(id)) sql.exec(`DELETE FROM ${SNAPSHOTS} WHERE id = ?`, id)
  }

  return {
    liveness: 'socket',
    start(h) {
      hooks = h
      // after the synchronous construction that called us, so the host's handlers exist before a replay needs them
      return Promise.resolve().then(resume)
    },
    stop() {
      hooks = undefined
    },
    onSnapshotChanged(id, snapshot) {
      sql.exec(`INSERT OR REPLACE INTO ${SNAPSHOTS} (id, snapshot) VALUES (?, ?)`, id, JSON.stringify(snapshot))
    },
    onHold(count) {
      if (count > 0 && busy === undefined) busy = setInterval(() => {}, 30_000)
      if (count === 0 && busy !== undefined) {
        clearInterval(busy)
        busy = undefined
      }
    },
    fetch,
    webSocketMessage(ws, message) {
      const conn = conns.get(ws)
      if (!conn) {
        ws.close(CLOSE_NOT_RESUMABLE, 'connection could not be resumed')
        return
      }
      conn.deliver(typeof message === 'string' ? encoder.encode(message) : new Uint8Array(message))
    },
    webSocketClose(ws, code, reason) {
      conns.get(ws)?.closed(code, reason)
    },
    webSocketError(ws) {
      conns.get(ws)?.closed(1006)
    },
  }
}

/** One hibernatable socket as the server sees it. Closing it — from either side — reports exactly once. */
class DurableConn implements RawConn {
  private msgCb?: (bytes: Uint8Array) => void
  private closeCb?: (code: number, reason?: string) => void
  private done = false

  constructor(
    private readonly ws: WebSocket,
    readonly id: string,
    private readonly onGone: () => void,
  ) {}

  get writable(): boolean {
    return !this.done && this.ws.readyState === WebSocket.OPEN
  }
  send(bytes: string | Uint8Array): void {
    if (this.writable) this.ws.send(bytes)
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason?: string) => void): void {
    this.closeCb = cb
  }
  onDrain(): void {} // the platform exposes no send-buffer signal
  close(code = 1000, reason?: string): void {
    if (this.done) return
    this.ws.close(code, reason)
    this.closed(code, reason) // a server-initiated close need not come back as a webSocketClose event
  }
  terminate(): void {
    this.close(1011, 'terminated') // 1006 is reserved for the runtime; it cannot be sent
  }
  deliver(bytes: Uint8Array): void {
    if (!this.done) this.msgCb?.(bytes)
  }
  closed(code: number, reason?: string): void {
    if (this.done) return
    this.done = true
    this.closeCb?.(code, reason)
    this.onGone()
  }
}

function buildHandshake(request: Request): Handshake {
  const url = new URL(request.url)
  const query: Record<string, string> = {}
  for (const [k, v] of url.searchParams) query[k] = v
  const headers: Record<string, string> = {}
  request.headers.forEach((v, k) => {
    headers[k] = v
  })
  return { transport: 'cloudflare', headers, query, raw: request }
}

function reservedFor(list: ReservedConnection[], request: Request, handshake: Handshake): ReservedConnection | undefined {
  if (list.length === 0) return undefined
  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim())
  return list.find((rc) => rc.subprotocol && offered.includes(rc.subprotocol)) ?? list.find((rc) => rc.match?.(handshake))
}

function refuseAfterUpgrade(subprotocol: string | undefined, err: unknown): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.accept()
  server.close(4401, truncateReason(err instanceof Error && err.message ? err.message : 'unauthorized'))
  return new Response(null, { status: 101, webSocket: client, ...(subprotocol ? { headers: { 'Sec-WebSocket-Protocol': subprotocol } } : {}) })
}

// A close reason is capped at 123 UTF-8 bytes.
function truncateReason(reason: string): string {
  const bytes = encoder.encode(reason)
  return bytes.length <= 123 ? reason : new TextDecoder().decode(bytes.slice(0, 123)).replace(/�$/, '')
}
