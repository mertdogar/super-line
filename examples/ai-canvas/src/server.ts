import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { syncStoreServer } from '@super-line/store-sync'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'
import { runAgent } from './agent.js'
import { resolveOptions, SCENE_ID } from './scene.js'

const PORT = Number(process.env.PORT ?? 8796)
const server = http.createServer()

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  // the handshake `name` becomes the ACL principal (stable across reconnects)
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  identify: (conn) => (conn.ctx as { name: string }).name,
  // The CRDT Store, in `document` mode (recursive merge) via the shared resolver — so the agent and
  // humans can edit different shapes at the same time without clobbering each other.
  stores: { scene: syncStoreServer({ resolveOptions }) },
  // Deny-by-default: grant every connection read+write on the shared board as it arrives.
  onConnection: (conn) => {
    const principal = conn.principal ?? conn.id
    void srv.store('scene').grant(SCENE_ID, principal, { read: true, write: true })
  },
})

// Seed an empty board once, server-authoritative, before anyone connects.
await srv.store('scene').create(SCENE_ID, { shapes: {} }, {})

let runs = 0
srv.implement({
  user: {
    // The AI co-writer: open a reactive replica over the canonical scene, let the agent edit it via
    // tools, then release the handle. `origin` stamps the agent's writes (visible in the Control Center).
    agentEdit: async ({ prompt }) => {
      const replica = srv.store('scene').open(SCENE_ID, { origin: `agent:${++runs}` })
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
