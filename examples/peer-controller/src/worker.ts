import { peer } from '@super-line/plugin-peer/server'
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { contract, type Config, type Role } from './contract.js'

interface Env {
  NODE: DurableObjectNamespace
  /** Optional JSON array of RTCIceServer, e.g. your own TURN server. */
  ICE_SERVERS?: string
  /** Optional Cloudflare Realtime TURN key; with both set, each page load gets short-lived TURN credentials. */
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
}

const iceServers = async (env: Env): Promise<RTCIceServer[]> => {
  if (env.ICE_SERVERS) return JSON.parse(env.ICE_SERVERS)
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [{ urls: 'stun:stun.cloudflare.com:3478' }]
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
  })
  if (!res.ok) throw new Error(`TURN credentials: ${res.status} ${await res.text()}`)
  const { iceServers } = (await res.json()) as { iceServers: RTCIceServer[] }
  // browsers block port 53, and a blocked TURN URL only adds a timeout
  return iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }))
}

// The same server as server.ts, with a Durable Object as the node. The peer plugin keeps no state, so the
// object hibernates between join requests while the phones keep talking to the screen directly.
export class PeerNode extends createDurableNode((_ctx, _env: Env, base) => {
  console.log('node constructed')
  return createSuperLineServer(contract, {
    ...base,
    authenticate: (h) => ({
      role: (h.query.role === 'screen' ? 'screen' : 'controller') as Role,
      ctx: { name: (h.query.name ?? '').trim().slice(0, 24) || 'Player' },
    }),
    plugins: [
      peer<{ name: string }>({
        authorizeCreate: ({ creator }) => creator.role === 'screen',
        authorize: ({ ctx }) => ({ info: { name: ctx.name } }),
      }).plugin,
    ],
  })
}) {}

export default {
  // Files in ./dist are served before this runs. Only /ws reaches the node, because every request it gets wakes it.
  fetch: async (request, env) => {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return routeToNode(request, env.NODE)
    if (url.pathname === '/config.json') {
      const config: Config = { joinBase: url.origin, iceServers: await iceServers(env) }
      return Response.json(config, { headers: { 'cache-control': 'no-store' } })
    }
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
