import http from 'node:http'

/**
 * The lab's control plane: a tiny JSON-over-HTTP server every actor runs.
 *
 * It is deliberately NOT super-line. The conductor's readiness gate, phase transitions and flush
 * signals must not appear in the traffic being measured, so they ride a channel the measurement
 * cannot see (PLAN decision 6).
 */
export type Route = (body: Record<string, unknown>) => unknown | Promise<unknown>

export function serveControl(port: number, routes: Record<string, Route>): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const route = routes[path]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `no route ${path}` }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
          const out = await route(body)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(out ?? { ok: true }))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })()
    })
  })
  server.listen(port, '0.0.0.0')
  return server
}

/** POST JSON to an actor's control plane and decode its reply. Throws on a non-2xx, carrying the actor's message. */
export async function call<T>(base: string, path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${base}${path} → ${res.status}: ${text}`)
  return JSON.parse(text) as T
}

/**
 * Poll an actor until it answers `{ ok: true }` or the deadline passes. The whole point of the
 * readiness gate is that a slow container never silently shifts a phase boundary.
 */
export async function waitReady<T extends { ok?: boolean }>(
  base: string,
  timeoutMs: number,
  accept: (state: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const state = await call<T>(base, '/ready')
      if (accept(state)) return state
      last = state
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() > deadline) throw new Error(`traffic-lab: ${base} never became ready — last: ${JSON.stringify(last)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
