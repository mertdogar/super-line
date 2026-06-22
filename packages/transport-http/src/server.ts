import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import type { RawConn, ServerTransport, Handshake, AuthOutcome } from '@super-line/core'
import { encodeFrame, decodeFrame } from './codec.js'

/** Options for {@link httpServerTransport}. */
export interface HttpServerTransportOptions {
  /** The `http.Server` to attach to (compose on the same server as `webSocketServerTransport`). */
  server: HttpServer
  /** URL prefix for this transport's routes. Defaults to `/superline`. Requests outside it pass through untouched. */
  basePath?: string
  /** Idle grace before a session with no client activity is reaped (ms). Defaults to `60_000`. */
  sessionTimeout?: number
  /** SSE keepalive comment interval (ms) — survives idle-proxy reaping. Defaults to `20_000`. */
  keepalive?: number
  /** How long a long-poll request is held open before returning empty (ms). Defaults to `25_000`. */
  pollTimeout?: number
  /** Max POST body size (bytes); larger requests get `413`. Defaults to `1_000_000`. */
  maxBodyBytes?: number
  /** Opt-in CORS for cross-origin browser clients. */
  cors?: { origin?: string }
}

interface Session {
  id: string
  mode: 'sse' | 'longpoll'
  res?: ServerResponse // the live SSE stream, or the currently-parked poll response
  pollTimer?: ReturnType<typeof setTimeout>
  queue: string[] // base64 frames awaiting a downstream (long-poll)
  onMessage?: (bytes: Uint8Array) => void
  onClose?: (code: number, reason?: string) => void
  closing: boolean
  lastSeen: number
  keepaliveTimer?: ReturnType<typeof setInterval>
}

/** An HTTP transport: SSE or long-poll downstream + POST upstream, mounted on an `http.Server`. */
export function httpServerTransport(opts: HttpServerTransportOptions): ServerTransport {
  const basePath = opts.basePath ?? '/superline'
  const sessionTimeout = opts.sessionTimeout ?? 60_000
  const keepaliveMs = opts.keepalive ?? 20_000
  const pollTimeoutMs = opts.pollTimeout ?? 25_000
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000
  const sessions = new Map<string, Session>()
  let hooks: Parameters<ServerTransport['start']>[0] | undefined
  let requestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  let sweep: ReturnType<typeof setInterval> | undefined
  let stopped = false

  function setCors(res: ServerResponse): void {
    if (!opts.cors) return
    res.setHeader('Access-Control-Allow-Origin', opts.cors.origin ?? '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
  }

  function endSession(session: Session, code: number, reason?: string): void {
    if (!sessions.has(session.id)) return
    sessions.delete(session.id)
    session.closing = true
    if (session.keepaliveTimer) clearInterval(session.keepaliveTimer)
    if (session.pollTimer) clearTimeout(session.pollTimer)
    try {
      session.res?.end()
    } catch {
      /* already torn down */
    }
    session.res = undefined
    const onClose = session.onClose
    session.onMessage = undefined // no frame delivery after onClose (uphold the loopback/ws invariant)
    session.onClose = undefined
    onClose?.(code, reason)
  }

  function flushPoll(session: Session, frames: string[]): void {
    const res = session.res
    if (!res) return
    if (session.pollTimer) {
      clearTimeout(session.pollTimer)
      session.pollTimer = undefined
    }
    session.res = undefined
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
    res.end(JSON.stringify({ frames }))
  }

  function makeRawConn(session: Session): RawConn {
    return {
      get writable() {
        return !session.closing && sessions.has(session.id)
      },
      send(bytes) {
        if (session.closing || !sessions.has(session.id)) return
        const b64 = encodeFrame(bytes)
        if (session.mode === 'sse') {
          session.res?.write(`data: ${b64}\n\n`)
          return
        }
        // only flush to a still-live parked poll; a dead/ending res must NOT swallow the frame
        if (session.res && !session.res.writableEnded && !session.res.destroyed) {
          const frames = [...session.queue, b64]
          session.queue.length = 0
          flushPoll(session, frames)
        } else {
          session.res = undefined // drop a stale parked-res pointer
          session.queue.push(b64) // survives for the next /poll
        }
      },
      onMessage(cb) {
        session.onMessage = cb
      },
      onClose(cb) {
        session.onClose = cb
      },
      onDrain() {},
      close(code = 1000, reason) {
        endSession(session, code, reason)
      },
      terminate() {
        endSession(session, 1006)
      },
    }
  }

  function queryObj(url: URL): Record<string, string> {
    const q: Record<string, string> = {}
    for (const [k, v] of url.searchParams) q[k] = v
    return q
  }

  async function authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    transport: string,
  ): Promise<AuthOutcome | undefined> {
    const handshake: Handshake = { transport, headers: req.headers, query: queryObj(url), raw: req }
    let auth: AuthOutcome
    try {
      auth = await hooks!.authenticate(handshake)
    } catch {
      res.writeHead(401)
      res.end()
      return undefined
    }
    if (stopped) {
      res.writeHead(503)
      res.end()
      return undefined
    }
    return auth
  }

  function createSession(mode: 'sse' | 'longpoll'): Session {
    const id = randomUUID()
    const session: Session = { id, mode, queue: [], closing: false, lastSeen: Date.now() }
    sessions.set(id, session)
    return session
  }

  async function handleSse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = await authenticate(req, res, url, 'sse')
    if (!auth) return
    const session = createSession('sse')
    session.res = res
    setCors(res)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    res.write(`event: sl-open\ndata: ${session.id}\n\n`)
    session.keepaliveTimer = setInterval(() => {
      if (!session.res) return
      try {
        session.res.write(':\n\n')
        session.lastSeen = Date.now()
      } catch {
        /* stream gone; res 'close' will reap */
      }
    }, keepaliveMs)
    session.keepaliveTimer.unref?.()
    res.on('close', () => {
      if (session.res === res) endSession(session, 1006) // the SSE stream died
    })
    hooks!.onConnection(makeRawConn(session), auth)
  }

  async function handleHandshake(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = await authenticate(req, res, url, 'longpoll')
    if (!auth) return
    const session = createSession('longpoll')
    setCors(res)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
    res.end(JSON.stringify({ sid: session.id }))
    hooks!.onConnection(makeRawConn(session), auth)
  }

  function handlePoll(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sid = url.searchParams.get('sid')
    const session = sid ? sessions.get(sid) : undefined
    if (!session || session.closing) {
      res.writeHead(410)
      res.end()
      return
    }
    session.lastSeen = Date.now()
    setCors(res)
    if (session.queue.length > 0) {
      const frames = session.queue.splice(0)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
      res.end(JSON.stringify({ frames }))
      return
    }
    if (session.res) flushPoll(session, []) // evict a prior parked poll (proxy retry / duplicate); it re-polls
    session.res = res
    session.pollTimer = setTimeout(() => {
      if (session.res === res) {
        session.res = undefined
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        res.end(JSON.stringify({ frames: [] }))
      }
    }, pollTimeoutMs)
    session.pollTimer.unref?.()
    res.on('close', () => {
      // a long-poll GET closes constantly (between polls) — clear the parked pointer, DON'T kill the session
      if (session.res === res) {
        session.res = undefined
        if (session.pollTimer) clearTimeout(session.pollTimer)
      }
    })
  }

  function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBodyBytes) {
          res.writeHead(413)
          res.end()
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(undefined))
    })
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sid = url.searchParams.get('sid')
    const session = sid ? sessions.get(sid) : undefined
    if (!session || session.closing) {
      res.writeHead(410)
      res.end()
      return
    }
    session.lastSeen = Date.now()
    const body = await readBody(req, res)
    if (body === undefined) return // 413 already sent
    let frames: string[]
    try {
      frames = (JSON.parse(body) as { frames: string[] }).frames
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    setCors(res)
    res.writeHead(204)
    res.end()
    for (const b64 of frames) session.onMessage?.(decodeFrame(b64))
  }

  async function handleClose(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sid = url.searchParams.get('sid')
    const session = sid ? sessions.get(sid) : undefined
    setCors(res)
    res.writeHead(204)
    res.end()
    if (session && !session.closing) endSession(session, 1000)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // pass-through on a path boundary: `/superline` and `/superline/...` are ours; `/superline-admin` is NOT
    if (url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) return
    if (res.headersSent) return // a co-mounted handler already answered this request
    const sub = url.pathname.slice(basePath.length)
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      setCors(res)
      res.writeHead(204)
      res.end()
      return
    }
    if (method === 'GET' && sub === '/sse') return void handleSse(req, res, url)
    if (method === 'GET' && sub === '/handshake') return void handleHandshake(req, res, url)
    if (method === 'GET' && sub === '/poll') return handlePoll(req, res, url)
    if (method === 'POST' && sub === '/send') return void handleSend(req, res, url)
    if (method === 'POST' && sub === '/close') return void handleClose(req, res, url)
    res.writeHead(404)
    res.end()
  }

  return {
    start(h) {
      hooks = h
      requestHandler = onRequest
      opts.server.on('request', requestHandler)
      sweep = setInterval(() => {
        const now = Date.now()
        for (const session of sessions.values()) {
          // a live downstream (open SSE stream / parked poll) means the client is present; its death is
          // handled by the SSE res 'close' reaper. Only reap sessions with NO downstream that went idle.
          if (session.res && !session.res.writableEnded && !session.res.destroyed) continue
          if (now - session.lastSeen > sessionTimeout) endSession(session, 1006)
        }
      }, Math.max(1000, Math.floor(sessionTimeout / 2)))
      sweep.unref?.()
    },
    stop() {
      stopped = true
      if (requestHandler) opts.server.removeListener('request', requestHandler)
      if (sweep) clearInterval(sweep)
      for (const session of sessions.values()) endSession(session, 1006)
    },
  }
}
