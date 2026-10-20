import { cloudflareCollections } from '@super-line/collections-cloudflare'
import type { AuthContext } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chat } from '@super-line/plugin-chat/server'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { base } from './contract-base.js'
import { workspace } from './workspace.js'

interface Env {
  NODE: DurableObjectNamespace
  /** Set with `wrangler secret put SUPER_LINE_INSPECTOR_PASSWORD`; unset, the Control Center channel is open. */
  SUPER_LINE_INSPECTOR_PASSWORD?: string
}

const NODE = 'cloudflare'

// The playground on ONE Durable Object: auth, chat and presence over the WebSocket transport, rows in the object's
// own SQLite. No queues — a polling queue would keep the object awake forever. This factory runs on first use and
// again on every wake from hibernation, so everything in it is cheap and idempotent.
export class PlaygroundNode extends createDurableNode((ctx, env: Env, nodeBase) => {
  console.log('node constructed') // first use, then once per wake — watch it in `wrangler dev` / `wrangler tail`
  const collections = cloudflareCollections(ctx.storage, base.collections)
  const authKit = auth({ contract: base, collections, defaultRoles: ['user'] })
  const chatKit = chat({
    contract: base,
    hooks: {
      sendMessage: {
        // `/bot …` streams the reply straight from here; an open stream keeps the object awake until it settles.
        after: (message) => {
          const text = typeof message.content === 'string' ? message.content : ''
          if (!text.startsWith('/bot')) return
          void work.streamBotReply(message.channelId, text.slice(4).trim(), NODE).catch((err) => console.error('bot reply failed', err))
        },
      },
    },
  })
  const work = workspace({ users: authKit.users, credentials: authKit.credentials, chatKit })
  const password = env.SUPER_LINE_INSPECTOR_PASSWORD

  const srv = createSuperLineServer(base, {
    ...nodeBase,
    nodeName: NODE,
    collections,
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    plugins: [authKit.plugin, chatKit.plugin, inspector(password ? { auth: { password } } : {})],
    // runs again for every socket a wake resumes, so welcome() tolerates an existing membership
    onConnection: (_conn, connCtx) => {
      const { userId } = connCtx as AuthContext
      if (userId) void seeded.then(() => work.welcome(userId)).catch((err) => console.error('welcome failed', err))
    },
  })

  srv.implement({
    user: {
      whereAmI: async (_input, _ctx, conn) => ({ node: NODE, nodeId: srv.nodeId, connId: conn.id }),
      cluster: async () => {
        const [nodes, conns] = await Promise.all([srv.cluster.topology(), srv.cluster.connections()])
        return {
          nodes: nodes.map(({ nodeId, nodeName, connections, alive }) => ({ nodeId, nodeName, connections, alive })),
          connections: conns.map(({ id, nodeId, role, userId, transport, connectedAt }) => ({ id, nodeId, role, userId, transport, connectedAt })),
        }
      },
      nudge: async ({ userId, text }, _ctx, conn) => {
        const me = await authKit.users.get((conn.ctx as AuthContext).userId!)
        srv.toUser(userId).emit('nudge', { from: me?.displayName ?? 'someone', fromNode: NODE, text })
        return { online: await srv.isOnline(userId) }
      },
    },
  })

  // Seeding inside blockConcurrencyWhile holds every event until it finishes, so two first connections can't
  // both create the channels. After the first boot it is two SQL reads per wake.
  const seeded = ctx.blockConcurrencyWhile(async () => {
    await srv.ready
    await work.seed()
  })

  return srv
}) {}

export default {
  // Files in ./dist-cloudflare are served before this runs. Only /ws reaches the node: any request it gets wakes it.
  fetch: (request, env) =>
    new URL(request.url).pathname === '/ws' ? routeToNode(request, env.NODE) : new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>
