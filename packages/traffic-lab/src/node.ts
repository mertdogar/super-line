import http from 'node:http'
import { jsonSerializer, type Adapter } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter, type PubSubLibp2p } from '@super-line/adapter-libp2p'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { inspector } from '@super-line/plugin-inspector'
import { lab } from './contract.js'
import { serveControl } from './control.js'
import { adapterKind, flag, num, runId, str } from './env.js'
import { Recorder } from './tap/record.js'
import { tapAdapter } from './tap/adapter-tap.js'
import { tapMesh } from './tap/mesh-tap.js'
import { serverTapPlugin } from './tap/plugins.js'
import { sampleNic } from './tap/nic.js'

const NODE = str('NODE_NAME')
const PORT = num('PORT', 8800)
const CTRL_PORT = num('CTRL_PORT', 8900)
const P2P_PORT = num('P2P_PORT', 9001)
const KIND = adapterKind()
const INSPECTOR = flag('SL_INSPECTOR')
const TOPIC = str('P2P_TOPIC', 'super-line/v1')

type Ctx = { name: string }
type LabAdapter = Adapter & { node?: PubSubLibp2p }

const rec = new Recorder(NODE, str('DUMP_DIR', '/runs'), runId())

/**
 * Both adapters are built the same way: no persistent identity (mDNS re-finds peers after a restart) and
 * no tuning. The Redis profile is the control — it filters at the broker, which is exactly the property
 * libp2p's single shared topic lacks.
 */
async function buildAdapter(): Promise<LabAdapter> {
  if (KIND === 'redis') return createRedisAdapter({ url: str('REDIS_URL', 'redis://redis:6379') })
  return createLibp2pAdapter({ discovery: 'mdns', listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`], topic: TOPIC })
}

const decode = (payload: string | Uint8Array): unknown => jsonSerializer.decode(payload)
const { adapter, interest } = tapAdapter(await buildAdapter(), rec, decode)
// L3 only exists on libp2p: Redis has no mesh to listen to, and filters at the broker, so its acceptance
// ratio is 1.0 by construction. The report states that asymmetry rather than pretending to measure it.
const mesh = adapter.node ? tapMesh(adapter.node, TOPIC, rec, interest, decode) : undefined

rec.write({ layer: 'meta', node: NODE, adapter: KIND, inspector: INSPECTOR, ...(mesh ? { peerId: mesh.peerId } : {}) })

const wsServer = http.createServer()
const plugins = INSPECTOR ? [serverTapPlugin(rec), inspector()] : [serverTapPlugin(rec)]

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
  '/phase': (body) => {
    // NIC is sampled at every boundary, so a phase's total wire cost is the difference across its edges.
    sampleNic(rec)
    rec.setPhase(body.phase === null ? null : Number(body.phase))
    return { ok: true, node: NODE }
  },
  '/flush': () => {
    sampleNic(rec)
    return { ok: true, node: NODE, ...rec.flush(), interest: interest.snapshot().length }
  },
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
