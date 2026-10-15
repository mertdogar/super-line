import { DurableObject } from 'cloudflare:workers'

// Smoke Durable Object for the workers lane. Counts its own constructions in SQLite so a test can
// prove the constructor reran after eviction while the hibernated socket stayed open.
export class SmokeNode extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS boots (n INTEGER NOT NULL)')
    const row = ctx.storage.sql.exec<{ n: number }>('SELECT n FROM boots').toArray()[0]
    if (row) ctx.storage.sql.exec('UPDATE boots SET n = ?', row.n + 1)
    else ctx.storage.sql.exec('INSERT INTO boots (n) VALUES (1)')
  }

  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const id = crypto.randomUUID()
    this.ctx.acceptWebSocket(pair[1], [id])
    pair[1].serializeAttachment({ id })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const boots = this.ctx.storage.sql.exec<{ n: number }>('SELECT n FROM boots').one().n
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    ws.send(`echo:${text} boots=${boots}`)
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
  }
}

export default {
  fetch: (request: Request, env: Cloudflare.Env) =>
    env.SMOKE.get(env.SMOKE.idFromName('smoke')).fetch(request),
}
