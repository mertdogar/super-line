import http from 'node:http'
import type { Adapter } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter, type PubSubLibp2p } from '@super-line/adapter-libp2p'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { inspector } from '@super-line/plugin-inspector'
import { lab } from './contract.js'
import { serveControl } from './control.js'
import { adapterKind, flag, num, str } from './env.js'

const NODE = str('NODE_NAME')
const PORT = num('PORT', 8800)
const CTRL_PORT = num('CTRL_PORT', 8900)
const P2P_PORT = num('P2P_PORT', 9001)
const KIND = adapterKind()
const INSPECTOR = flag('SL_INSPECTOR')

type Ctx = { name: string }

/**
 * Both adapters are built the same way for the lab: no persistent identity (mDNS re-finds peers after a
 * restart, so a stable peer id would be noise) and no tuning. The Redis profile is the control — it filters
 * at the broker, which is exactly the property libp2p's single shared topic lacks.
 */
async function buildAdapter(): Promise<Adapter & { node?: PubSubLibp2p }> {
  if (KIND === 'redis') return createRedisAdapter({ url: str('REDIS_URL', 'redis://redis:6379') })
  return createLibp2pAdapter({ discovery: 'mdns', listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`] })
}

const adapter = await buildAdapter()
const wsServer = http.createServer()
const plugins = INSPECTOR ? [inspector()] : []

const srv = createSuperLineServer(lab, {
  transports: [webSocketServerTransport({ server: wsServer })],
  adapter,
  nodeName: NODE,
  authenticate: (h) => ({ role: 'user' as const, ctx: { name: h.query.name ?? 'anon' } as Ctx }),
  identify: (conn) => (conn.ctx as Ctx).name,
  collections: memoryCollections(),
  crdtCollections: crdtMemoryCollections(),
  // Deny-by-default is the real policy shape; the lab measures fan-out, not authorization, so both are open.
  policies: {
    rows: { read: () => undefined, write: () => true },
    docs: { read: () => true, write: () => true },
  },
  plugins,
})

srv.implement({
  user: {
    ping: async () => ({ ok: true, node: NODE }),
    whoami: async (_input, _ctx, conn) => ({ connId: conn.id, node: NODE }),
    emitTo: async ({ target, ...payload }) => {
      srv.toConn(target).emit('direct', payload)
      return { ok: true }
    },
    joinRoom: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      return { ok: true }
    },
    leaveRoom: async ({ room }, _ctx, conn) => {
      srv.room(room).remove(conn)
      return { ok: true }
    },
    broadcastRoom: async ({ room, ...payload }) => {
      srv.room(room).broadcast('roomMsg', payload)
      return { ok: true }
    },
    publishTopic: async (payload) => {
      srv.forRole('user').publish('announce', payload)
      return { ok: true }
    },
    busPublish: async (payload) => {
      srv.publish('stats', payload)
      return { ok: true }
    },
  },
})

// The bus needs a server-side listener on every node or phase 5 measures a publish nobody consumes —
// which is a different finding from the one that phase is for.
let busReceived = 0
srv.subscribe('stats', () => {
  busReceived++
})

const peers = (): number =>
  adapter.node ? new Set(adapter.node.getConnections().map((c) => c.remotePeer.toString())).size : 0

serveControl(CTRL_PORT, {
  '/ready': () => ({ ok: true, node: NODE, adapter: KIND, inspector: INSPECTOR, peers: peers(), busReceived }),
  // Creation is server-authoritative for CRDT collections, and it must happen after the mesh forms or the
  // relayed create is lost — so the conductor drives it rather than boot doing it blind.
  '/seed': async (body) => {
    const ids = (body.docs as string[] | undefined) ?? []
    for (const id of ids) await srv.collection('docs').create(id, { title: id, cells: {} })
    return { ok: true, seeded: ids.length }
  },
})

wsServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[${NODE}] traffic-lab node · ws :${PORT} · control :${CTRL_PORT} · adapter=${KIND} · inspector=${INSPECTOR}`)
})
