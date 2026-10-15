import { DurableObject } from 'cloudflare:workers'
import { INSPECTOR_SUBPROTOCOL, type AuthOutcome, type Handshake } from '@super-line/core'
import { cloudflareServerTransport, createDurableNode } from '@super-line/transport-cloudflare'
import { createSuperLineServer } from '@super-line/server'
import { cloudflareCollections } from '@super-line/collections-cloudflare'
import { crdtCloudflareCollections } from '@super-line/collections-crdt-cloudflare'
import { auth } from '@super-line/plugin-auth/server'
import { appContract, authApp } from './app.js'

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

// The bare transport inside a Durable Object, started with recording hooks — the Cloudflare counterpart of
// transport-websocket's own tests. Accepts `user` unless the query says `reject`; echoes bytes upper-cased.
export class RawNode extends DurableObject<Cloudflare.Env> {
  readonly transport = cloudflareServerTransport(this.ctx)
  readonly handshakes: Handshake[] = []
  readonly accepted: AuthOutcome[] = []

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    void this.transport.start({
      authenticate: async (h) => {
        this.handshakes.push(h)
        if (h.query.reject) throw new Error('rejected by test')
        return { role: 'user', ctx: { uid: h.query.uid } }
      },
      onConnection: (raw, auth) => {
        this.accepted.push(auth)
        raw.onMessage((bytes) => raw.send(new TextDecoder().decode(bytes).toUpperCase()))
      },
      reserved: [
        {
          role: 'inspector',
          subprotocol: INSPECTOR_SUBPROTOCOL,
          authenticate: (h) => {
            if (h.query.pw !== 'open sesame') throw new Error('bad inspector password')
            return { admin: true }
          },
        },
      ],
    })
  }

  override fetch(request: Request): Promise<Response> {
    return this.transport.fetch(request)
  }
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.transport.webSocketMessage(ws, message)
  }
  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.transport.webSocketClose(ws, code, reason)
  }
  override webSocketError(ws: WebSocket, error: unknown): void {
    this.transport.webSocketError(ws, error)
  }
}

// A whole super-line node. Counts its constructions, so a test can tell a real wake from a warm instance.
export class AppNode extends createDurableNode((ctx, _env, base) => {
  const sql = ctx.storage.sql
  sql.exec('CREATE TABLE IF NOT EXISTS app_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL)')
  sql.exec("INSERT INTO app_state (k, v) VALUES ('boots', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1")
  const locked = () => sql.exec("SELECT v FROM app_state WHERE k = 'locked'").toArray().length > 0
  const srv = createSuperLineServer(appContract, {
    ...base,
    collections: cloudflareCollections(ctx.storage, appContract.collections),
    crdtCollections: crdtCloudflareCollections(ctx.storage, appContract.collections),
    policies: {
      notes: { read: () => undefined, write: () => true },
      boards: { read: () => true, write: () => true },
    },
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid: string }).uid,
    authorizeSubscribe: () => !locked(),
  })
  return srv.implement({
    user: {
      ping: async ({ n }) => ({ n }),
      shout: async ({ msg }) => {
        srv.forRole('user').publish('announce', { msg })
        return null
      },
      lock: async () => {
        sql.exec("INSERT OR REPLACE INTO app_state (k, v) VALUES ('locked', 1)")
        return null
      },
      createBoard: async ({ id, title }) => {
        await srv.collection('boards').create(id, { title })
        return null
      },
    },
  })
}) {}

// A node running plugin-auth, its sessions and presence on the object's SQLite.
export class AuthNode extends createDurableNode((ctx, _env, base) => {
  const collections = cloudflareCollections(ctx.storage, authApp.collections)
  const authKit = auth({ contract: authApp, collections, defaultRoles: ['user'] })
  return createSuperLineServer(authApp, {
    ...base,
    collections,
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    plugins: [authKit.plugin],
  }).implement({ user: { ping: async () => null } })
}) {}

// A bare object: the collection-backend tests drive its storage through `runInDurableObject`.
export class StoreNode extends DurableObject<Cloudflare.Env> {}

export default {
  fetch: (request: Request, env: Cloudflare.Env) =>
    env.SMOKE.get(env.SMOKE.idFromName('smoke')).fetch(request),
}
