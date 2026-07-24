import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { getLogger } from '@logtape/logtape'
import { WebSocketServer, type RawData, type WebSocket as WsServerSocket } from 'ws'
import {
  type RawConn,
  type ServerTransport,
  type ClientTransport,
  type Handshake,
  type AuthOutcome,
  type ReservedConnection,
} from '@super-line/core'

const logAuth = getLogger(['super-line', 'transport-websocket', 'auth'])

/** Backpressure policy for the WS server: what to do when a connection's send buffer grows too large. */
export interface Backpressure {
  /** Buffer size (bytes) above which {@link Backpressure.onExceed} kicks in. */
  maxBufferedBytes: number
  /** `'close'` (default) drops the connection with code 1013; `'drop'` skips the frame. */
  onExceed?: 'close' | 'drop'
}

/** Options for {@link webSocketServerTransport}. */
export interface WebSocketServerTransportOptions {
  /** The `http.Server` to attach to (compose with Express/Fastify/Hono). */
  server?: HttpServer
  /** Only handle upgrades for this pathname; others are left untouched. */
  path?: string
  /** Guard against slow consumers: when a connection's send buffer exceeds the limit, close or drop. */
  backpressure?: Backpressure
}

/** Options for {@link webSocketClientTransport}. */
export interface WebSocketClientTransportOptions {
  /** The server URL, e.g. `ws://localhost:3000`. */
  url: string
  /** Override the WebSocket implementation (defaults to `globalThis.WebSocket`). */
  WebSocket?: typeof WebSocket
}

/** A WebSocket server transport: attaches to an `http.Server` and accepts upgrades. */
export function webSocketServerTransport(opts: WebSocketServerTransportOptions = {}): ServerTransport {
  let hooks: Parameters<ServerTransport['start']>[0] | undefined
  let upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined
  let stopped = false

  // reserved connection classes the server declared via the start hooks (e.g. the inspector plugin's)
  const negotiable = (): ReservedConnection[] => hooks?.reserved ?? []

  // echo a reserved subprotocol the browser offered, so the WS handshake completes. Runs per-upgrade
  // (after start), so reading `hooks.reserved` is safe even though the server is built before start().
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const rc of negotiable()) if (rc.subprotocol && protocols.has(rc.subprotocol)) return rc.subprotocol
      return false
    },
  })

  // the reserved role for this upgrade, if it matches a declared class (by subprotocol, then by handshake)
  function reservedRoleFor(req: IncomingMessage): string | undefined {
    const list = negotiable()
    if (list.length === 0) return undefined
    const raw = req.headers['sec-websocket-protocol']
    const offered = raw ? (Array.isArray(raw) ? raw.join(',') : raw).split(',').map((p) => p.trim()) : []
    for (const rc of list) if (rc.subprotocol && offered.includes(rc.subprotocol)) return rc.role
    if (list.some((rc) => rc.match)) {
      const handshake = buildHandshake(req)
      for (const rc of list) if (rc.match?.(handshake)) return rc.role
    }
    return undefined
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (opts.path) {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')
      if (pathname !== opts.path) return
    }
    const accept = (auth: AuthOutcome): void => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        hooks!.onConnection(wsServerRawConn(ws, opts.backpressure), auth)
      })
    }
    const reservedRole = reservedRoleFor(req)
    if (reservedRole) {
      accept({ role: reservedRole, ctx: {} }) // short-circuit authenticate for a reserved (plugin-owned) connection
      return
    }
    let auth: AuthOutcome
    try {
      auth = await hooks!.authenticate(buildHandshake(req))
    } catch (err) {
      // A rejected authentication becomes a bare 401 on the wire — the reason never reaches the client. Log
      // it (via LogTape, off by default) so a THROWN auth error (a config bug, a nodeKey mistake, a rejecting
      // authenticate hook) is visible WHEN the operator enables logging, rather than silently discarded. Not
      // console — an app whose authenticate throws per-attempt would otherwise flood stderr. Routine rejections
      // (bad password, expired token) return a guest and never throw, so this is quiet under normal logins.
      logAuth.warning('authenticate threw — rejecting connection with 401 {error}', { error: err })
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (stopped) {
      socket.destroy() // the transport was stopped while authenticating — drop instead of accepting on a dead server
      return
    }
    accept(auth)
  }

  return {
    start(h) {
      hooks = h
      if (opts.server) {
        upgradeHandler = (req, socket, head) => {
          void handleUpgrade(req, socket, head)
        }
        opts.server.on('upgrade', upgradeHandler)
      }
    },
    async stop() {
      stopped = true
      if (opts.server && upgradeHandler) opts.server.removeListener('upgrade', upgradeHandler)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/** A WebSocket client transport: dials one server URL per `connect`. */
export function webSocketClientTransport(opts: WebSocketClientTransportOptions): ClientTransport {
  const resolved = opts.WebSocket ?? (globalThis.WebSocket as typeof WebSocket | undefined)
  if (!resolved) throw new Error('No WebSocket implementation found; pass opts.WebSocket')
  const WS: typeof WebSocket = resolved
  return {
    connect(handshakeParams, hooks) {
      const ws = new WS(buildUrl(opts.url, handshakeParams))
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => hooks.onOpen()
      ws.onmessage = (event: MessageEvent) => hooks.onMessage(toClientBytes(event.data))
      ws.onclose = (event: CloseEvent) => hooks.onClose(event.code)
      return {
        get writable() {
          return ws.readyState === WS.OPEN
        },
        send(bytes) {
          if (ws.readyState === WS.OPEN) ws.send(bytes)
        },
        onMessage() {}, // client core uses the hooks passed to connect()
        onClose() {},
        onDrain() {},
        close(code, reason) {
          ws.close(code, reason)
        },
        terminate() {
          ws.close() // browser WebSocket has no hard terminate
        },
      } satisfies RawConn
    },
  }
}

/** Wrap a `ws` socket as a {@link RawConn} (the server transport's per-connection adapter). Exported for tests. */
export function wsServerRawConn(ws: WsServerSocket, backpressure?: Backpressure): RawConn {
  // true => the frame was handled by the backpressure policy and must not be sent
  function overBackpressure(): boolean {
    if (!backpressure || ws.bufferedAmount <= backpressure.maxBufferedBytes) return false
    if (backpressure.onExceed === 'drop') {
      console.warn('[super-line] dropping frame: connection over backpressure limit')
      return true
    }
    ws.close(1013) // 'close' (default): too much backlog
    return true
  }
  return {
    get writable() {
      return ws.readyState === ws.OPEN
    },
    send(bytes) {
      if (ws.readyState !== ws.OPEN || overBackpressure()) return
      ws.send(bytes)
    },
    onMessage(cb) {
      ws.on('message', (data: RawData, isBinary: boolean) => cb(toWire(data, isBinary)))
    },
    onClose(cb) {
      ws.on('close', (code: number, reason: Buffer) => cb(code, reason.toString()))
    },
    onDrain() {},
    close(code, reason) {
      ws.close(code, reason)
    },
    terminate() {
      ws.terminate()
    },
  }
}

function buildHandshake(req: IncomingMessage): Handshake {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query: Record<string, string> = {}
  for (const [k, v] of url.searchParams) query[k] = v
  return { transport: 'websocket', headers: req.headers, query, raw: req }
}

function buildUrl(url: string, params: Record<string, string>): string {
  if (Object.keys(params).length === 0) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value)
  return u.toString()
}

const encoder = new TextEncoder()
function toClientBytes(data: string | ArrayBuffer | Blob): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array() // binaryType is 'arraybuffer', so Blob should not occur
}

function toWire(data: RawData, _isBinary: boolean): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data as Buffer)
}
