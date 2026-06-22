import type { RawConn, ClientTransport } from '@super-line/core'
import { encodeFrame, decodeFrame } from './codec.js'

/** Options for {@link httpClientTransport}. */
export interface HttpClientTransportOptions {
  /** The server origin, e.g. `http://localhost:3000`. */
  url: string
  /** URL prefix; MUST match the server's. Defaults to `/superline`. */
  basePath?: string
  /** Downstream mechanism. Defaults to `'sse'`. */
  mode?: 'sse' | 'longpoll'
  /** EventSource implementation (`globalThis.EventSource` is undefined in Node — pass the `eventsource` package). */
  EventSource?: typeof EventSource
  /** fetch implementation (defaults to `globalThis.fetch`, present in Node 18+ and browsers). */
  fetch?: typeof fetch
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** An HTTP client transport: dials the SSE/long-poll downstream and POSTs upstream. */
export function httpClientTransport(opts: HttpClientTransportOptions): ClientTransport {
  const basePath = opts.basePath ?? '/superline'
  const mode = opts.mode ?? 'sse'
  const resolvedFetch = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined)
  if (!resolvedFetch) throw new Error('No fetch implementation found; pass opts.fetch')
  const fetchImpl: typeof fetch = resolvedFetch
  const base = opts.url.replace(/\/+$/, '') + basePath

  return {
    connect(handshakeParams, hooks) {
      let sessionId: string | undefined
      let closed = false
      let es: EventSource | undefined

      function fireClose(code: number): void {
        if (closed) return
        closed = true
        es?.close()
        es = undefined
        hooks.onClose(code)
      }

      async function postFrames(frames: string[]): Promise<void> {
        if (!sessionId) return
        try {
          const res = await fetchImpl(`${base}/send?sid=${sessionId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ frames }),
          })
          if (res.status === 410) fireClose(1000) // server session gone -> core re-auths into a fresh Conn
        } catch {
          /* transient network error — physical churn, hidden from core */
        }
      }

      function startSse(): void {
        const ES = opts.EventSource ?? (globalThis.EventSource as typeof EventSource | undefined)
        if (!ES) throw new Error('No EventSource implementation found; pass opts.EventSource')
        es = new ES(buildUrl(`${base}/sse`, handshakeParams))
        es.addEventListener('sl-open', (e: Event) => {
          sessionId = (e as MessageEvent).data as string
          hooks.onOpen() // each (re)connect re-fires onOpen so core re-subscribes + resends unsent frames
        })
        es.onmessage = (e: MessageEvent) => hooks.onMessage(decodeFrame(e.data as string))
        // A stream drop nulls the sid (NOT a logical close) so `writable` goes false during the reconnect
        // gap and core buffers instead of POSTing to a now-dead session; the next sl-open re-arms it.
        es.onerror = () => {
          sessionId = undefined
        }
      }

      async function startLongpoll(): Promise<void> {
        try {
          const r = await fetchImpl(buildUrl(`${base}/handshake`, handshakeParams))
          if (!r.ok) return fireClose(1006)
          sessionId = ((await r.json()) as { sid: string }).sid
          hooks.onOpen()
          void pollLoop()
        } catch {
          fireClose(1006)
        }
      }

      async function pollLoop(): Promise<void> {
        while (!closed) {
          try {
            const res = await fetchImpl(`${base}/poll?sid=${sessionId}`)
            if (res.status === 410) return fireClose(1000)
            if (!res.ok) {
              await sleep(200) // transient; brief backoff, then retry (hidden churn)
              continue
            }
            const { frames } = (await res.json()) as { frames: string[] }
            for (const b64 of frames) hooks.onMessage(decodeFrame(b64))
          } catch {
            if (closed) return
            await sleep(200)
          }
        }
      }

      if (mode === 'sse') startSse()
      else void startLongpoll()

      return {
        get writable() {
          return !closed && sessionId !== undefined
        },
        send(bytes) {
          if (closed || !sessionId) return
          void postFrames([encodeFrame(bytes)])
        },
        onMessage() {}, // client core uses the hooks passed to connect()
        onClose() {},
        onDrain() {},
        close(_code, _reason) {
          if (closed) return
          if (sessionId) void fetchImpl(`${base}/close?sid=${sessionId}`, { method: 'POST' }).catch(() => {})
          fireClose(1000)
        },
        terminate() {
          fireClose(1006)
        },
      } satisfies RawConn
    },
  }
}

function buildUrl(url: string, params: Record<string, string>): string {
  if (Object.keys(params).length === 0) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}
