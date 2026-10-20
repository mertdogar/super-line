import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { eq } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { pgliteCollections } from '@super-line/collections-pglite'
import { inspector } from '@super-line/plugin-inspector'
import { auth } from '@super-line/plugin-auth/server'
import { chat } from '@super-line/plugin-chat/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { httpServerTransport } from '@super-line/transport-http'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import type { AuthContext } from '@super-line/plugin-auth'
import type { QueueJob } from '@super-line/plugin-queue'
import { app } from './contract.js'
import { queueKit } from './queue.js'

const PORT = Number(process.env.PORT ?? 8787) // WebSocket + HTTP share one http.Server
const P2P_PORT = Number(process.env.P2P_PORT ?? 9101) // libp2p /ws — the browser dials this directly
const NODE = process.env.NODE_NAME ?? 'node-1'
const PG_URL = process.env.PG_URL ?? 'postgres://postgres:password@localhost:5432/electric'
const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3000/v1/shape'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const BOT_NAME = 'Echo Bot'

// ONE CollectionStore for auth, chat and queue rows, shared by every node through Postgres. That shared
// database is what makes a queue slot cluster-wide and lets an account made on one node sign in on the other.
const collections = await pgliteCollections({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL, collections: app.collections })

const authKit = auth({ contract: app, collections, defaultRoles: ['user'] })

const chatKit = chat({
  contract: app,
  hooks: {
    sendMessage: {
      // `/bot …` hands the reply to the queue: whichever node claims the job streams it back into the channel.
      after: async (message) => {
        const text = typeof message.content === 'string' ? message.content : ''
        if (!text.startsWith('/bot')) return
        await queueKit.enqueue('botReply', { channelId: message.channelId, prompt: text.slice(4).trim() })
      },
    },
  },
})

// A PeerId seeded from the node name, so it is stable across restarts.
const keySeed = new Uint8Array(32)
new TextEncoder().encodeInto(NODE.padEnd(8, '·'), keySeed)
const p2p = await createLibp2p({
  privateKey: await generateKeyPairFromSeed('Ed25519', keySeed),
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
})

const server = http.createServer()
// The browser asks for this node's libp2p port + PeerId, then dials it directly.
server.on('request', (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/libp2p-addr') return
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ port: P2P_PORT, peerId: p2p.peerId.toString() }))
})

// Three wires into the same node. Everything above the transport seam — auth, chat, queues — can't tell them apart.
const srv = createSuperLineServer(app, {
  nodeKey: NODE, // plugin-auth sweeps this node's stale sessions by it; plugin-queue stamps it on claimed jobs
  nodeName: NODE,
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server }), libp2pServerTransport({ node: p2p })],
  adapter: createRedisAdapter(REDIS_URL),
  collections,
  plugins: [authKit.plugin, chatKit.plugin, queueKit.plugin, inspector()],
  authenticate: authKit.authenticate,
  identify: authKit.identify,
  onConnection: (_conn, ctx) => {
    const { userId } = ctx as AuthContext
    if (userId) void welcome(userId).catch((err) => console.error(`[${NODE}] welcome failed`, err))
  },
})

const userIdOf = (conn: { ctx: unknown }): string => (conn.ctx as AuthContext).userId!

const summarize = (job: QueueJob) => {
  const input = job.input as { label?: string; prompt?: string }
  return {
    id: job.id,
    queue: job.queue,
    label: input.label ?? `/bot ${input.prompt ?? ''}`,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    // the lease's nodeKey clears when the job settles; a completed job names its runner in its result
    node: job.nodeKey ?? (job.result as { processedBy?: string } | undefined)?.processedBy,
    error: job.lastError?.message,
    scheduled: job.scheduleId !== undefined,
    updatedAt: job.updatedAt,
  }
}

// Every user may drive every queue here — a playground. A real app authorizes these against ownership.
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
      const me = await authKit.users.get(userIdOf(conn))
      srv.toUser(userId).emit('nudge', { from: me?.displayName ?? 'someone', fromNode: NODE, text })
      return { online: await srv.isOnline(userId) }
    },
    enqueueReport: async ({ label, failRate, count }, _ctx, conn) => {
      const jobIds: string[] = []
      for (let i = 1; i <= count; i++) {
        const job = await queueKit.enqueue('report', {
          label: count > 1 ? `${label} #${i}` : label,
          failRate,
          userId: userIdOf(conn),
        })
        jobIds.push(job.id)
      }
      return { jobIds }
    },
    listJobs: async () => (await queueKit.list({ orderBy: [{ field: 'createdAt', dir: 'desc' }], limit: 40 })).map(summarize),
    cancelJob: async ({ jobId }) => ({ status: (await queueKit.cancel(jobId, { reason: 'cancelled from the playground' })).status }),
    retryJob: async ({ jobId }) => ({ jobId: (await queueKit.retry(jobId)).id }),
    listSchedules: async () =>
      (await queueKit.schedules.list()).map(({ id, queue, cron, enabled, nextRunAt }) => ({ id, queue, cron, enabled, nextRunAt })),
    setSchedule: async ({ id, enabled }) => {
      await (enabled ? queueKit.schedules.resume(id) : queueKit.schedules.pause(id))
      return { ok: true }
    },
    triggerSchedule: async ({ id }) => ({ jobId: (await queueKit.schedules.trigger(id)).id }),
  },
})

// ── workers — bound on BOTH nodes, so either may claim any job ───────────────────────────────────

queueKit.queue('report').setWorker(async ({ label, failRate, userId }, { jobId, attempt, signal }) => {
  // toUser() reaches the enqueuer on whichever node holds their connection — usually not this one.
  const progress = (text: string) => userId && srv.toUser(userId).emit('jobProgress', { jobId, label, node: NODE, text })
  progress(`started (attempt ${attempt})`)
  for (const pct of [25, 50, 75]) {
    await delay(700, undefined, { signal })
    progress(`${pct}%`)
  }
  await delay(700, undefined, { signal })
  if (Math.random() < failRate) {
    progress(`failed on attempt ${attempt}`)
    throw new Error(`simulated failure on ${NODE}`)
  }
  progress('done')
  return { processedBy: NODE }
})

let botId: string | undefined
async function bot(): Promise<string> {
  botId ??= (await authKit.users.find({ filter: eq('displayName', BOT_NAME) }))[0]?.id
  botId ??= (await authKit.users.create({ displayName: BOT_NAME })).id
  return botId
}

queueKit.queue('botReply').setWorker(async ({ channelId, prompt }, { signal }) => {
  const authorId = await bot()
  // every author must be a member — the server included
  if (!(await chatKit.members.get(channelId, authorId))) await chatKit.members.add(channelId, authorId)
  const writer = await chatKit.messages.stream({ channelId, authorId })
  try {
    await writer.push({ type: 'part_start', key: 'reply', partType: 'text' })
    const words = `${NODE} claimed this job and is streaming it word by word. You said: “${prompt || '…nothing'}”.`.split(' ')
    for (const word of words) {
      await delay(120, undefined, { signal })
      await writer.push({ type: 'delta', key: 'reply', text: `${word} ` })
    }
    await writer.push({ type: 'part_end', key: 'reply' })
    await writer.finalize()
  } catch (err) {
    await writer.abort(String(err)).catch(() => {})
    throw err
  }
  return { messageId: writer.messageId, processedBy: NODE }
})

/** Drop first-timers into every public channel so nobody lands on an empty workspace. */
async function welcome(userId: string): Promise<void> {
  if ((await chatKit.members.channelsOf(userId)).length > 0) return
  for (const channel of await chatKit.channels.find()) {
    await chatKit.members.add(channel.id, userId).catch(() => {})
  }
}

async function ignoreConflict(op: () => Promise<unknown>): Promise<void> {
  await op().catch((err: { code?: string }) => {
    if (err.code !== 'CONFLICT') throw err
  })
}

/** node-1 only: two channels, three demo logins, the bot, and a cron schedule. Idempotent across restarts. */
async function seed(): Promise<void> {
  const channels = new Set((await chatKit.channels.find()).map((c) => c.name))
  for (const name of ['general', 'random']) if (!channels.has(name)) await chatKit.channels.create({ name })

  const known = new Set((await authKit.users.find()).map((u) => u.displayName))
  for (const name of ['Ada', 'Grace', 'Linus']) {
    if (known.has(name)) continue
    const user = await authKit.users.create({ displayName: name })
    await authKit.credentials.create(user.id, { email: `${name.toLowerCase()}@example.com`, password: 'superline' })
    await welcome(user.id)
  }
  await bot()

  await ignoreConflict(() =>
    queueKit.schedules.create({
      id: 'report-every-minute',
      queue: 'report',
      cron: '* * * * *',
      input: { label: 'cron tick', failRate: 0, userId: null },
      misfirePolicy: 'latest',
      overlapPolicy: 'skip',
    }),
  )
}

if (process.env.SEED === 'true') await seed()

server.listen(PORT, () => {
  console.log(`[${NODE}] up on :${PORT} (WS + HTTP) · libp2p /ws :${P2P_PORT} · rows in postgres · adapter redis`)
  if (process.env.SEED === 'true') console.log('  demo logins: ada@ / grace@ / linus@example.com — password "superline"')
})

let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await srv.close()
  server.close()
  await p2p.stop()
  await collections.close?.()
  process.exit(0)
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
