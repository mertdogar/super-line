import { cloudflareCollections } from '@super-line/collections-cloudflare'
import type { AuthContext } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chat } from '@super-line/plugin-chat/server'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { contract } from './contract.js'

interface Env {
  NODE: DurableObjectNamespace
  /** Set with `wrangler secret put SUPER_LINE_INSPECTOR_PASSWORD`; unset, the Control Center channel is open. */
  SUPER_LINE_INSPECTOR_PASSWORD?: string
}

// The Durable Object IS the super-line node. This runs on first use and again on every wake from hibernation,
// so each "node constructed" line in `wrangler tail` after a quiet spell is a wake.
export class ChatNode extends createDurableNode((ctx, env: Env, base) => {
  console.log('node constructed')
  const collections = cloudflareCollections(ctx.storage, contract.collections)
  const authKit = auth({ contract, collections, defaultRoles: ['user'] })
  const chatKit = chat({ contract })
  const password = env.SUPER_LINE_INSPECTOR_PASSWORD

  const server = createSuperLineServer(contract, {
    ...base,
    collections,
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    plugins: [authKit.plugin, chatKit.plugin, inspector(password ? { auth: { password } } : {})],
    onConnection: (_conn, connCtx) => {
      const { userId } = connCtx as AuthContext
      if (userId) void joinGeneral(userId).catch((err) => console.error('joining #general failed', err))
    },
  })

  // Everyone lands in #general. Seeding inside blockConcurrencyWhile holds every event until it is done, so two
  // first connections can never both create the channel.
  const general = ctx.blockConcurrencyWhile(async () => {
    await server.ready
    const found = (await chatKit.channels.find()).find((c) => c.name === 'general')
    return (found ?? (await chatKit.channels.create({ name: 'general' }))).id
  })
  // Also runs for each socket a wake adopts, so it must tolerate an existing membership.
  const joinGeneral = async (userId: string): Promise<void> => {
    const channelId = await general
    if (!(await chatKit.members.get(channelId, userId))) await chatKit.members.add(channelId, userId)
  }

  return server
}) {}

export default {
  // Files in ./dist are served before this runs. Only /ws reaches the node: any request it gets wakes it, and a
  // stray /favicon.ico or crawler should not.
  fetch: (request, env) =>
    new URL(request.url).pathname === '/ws' ? routeToNode(request, env.NODE) : new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>
