import http from 'node:http'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'
import { runAgent } from './agent.js'
import { SCENE_ID } from './scene.js'

const PORT = Number(process.env.PORT ?? 8796)
const server = http.createServer()

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  // Surface traffic + collection values to the Control Center (dev/trusted only).
  plugins: [inspector()],
  // the handshake `name` becomes the principal (stable across reconnects)
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  identify: (conn) => (conn.ctx as { name: string }).name,
  // The CRDT document collection backend. `document` mode (on the contract's `crdt` option) makes the
  // scene a recursive CRDT — the agent and humans edit different shapes at once without clobbering.
  crdtCollections: crdtMemoryCollections(),
  // Guard-shaped, deny-by-default: this shared board is open to every authenticated connection.
  policies: {
    scene: { read: () => true, write: () => true },
  },
})

// Seed an empty board once, server-authoritative, before anyone connects (creation is server-only).
await srv.collection('scene').create(SCENE_ID, { shapes: {} })

let runs = 0
srv.implement({
  user: {
    // The AI co-writer: open a reactive replica over the canonical scene, let the agent edit it via
    // tools, then release the handle. `origin` stamps the agent's writes (visible in the Control Center).
    agentEdit: async ({ prompt }) => {
      const replica = srv.collection('scene').open(SCENE_ID, { origin: `agent:${++runs}` })
      try {
        return await runAgent(replica, prompt)
      } finally {
        replica.close()
      }
    },
  },
})

// Bind 0.0.0.0 so peers on the Tailscale network can reach it (clients connect back to location.hostname).
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ai-canvas server on http://0.0.0.0:${PORT}`)
})
