import http from 'node:http'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { pgliteCollections } from '@super-line/collections-pglite'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { app } from './contract.js'
import { dashboardHandlers } from './dashboard.js'
import { queueKit } from './queue.js'

const port = Number(process.env.PORT ?? 8801)
const nodeName = process.env.NODE_NAME ?? 'node-1'
const nodeKey = process.env.NODE_KEY ?? nodeName
const pgUrl = process.env.PG_URL ?? 'postgres://queue:queue@127.0.0.1:55432/queue'

const collections = await pgliteCollections({
  pgUrl,
  collections: app.collections ?? {},
  tablePrefix: 'queue_example_',
})

const httpServer = http.createServer()
const server = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server: httpServer })],
  authenticate: () => ({ role: 'dashboard' as const, ctx: {} }),
  adapter: await createLibp2pAdapter({ discovery: 'mdns' }),
  collections,
  nodeName,
  nodeKey,
  plugins: [queueKit.plugin, inspector()],
})
server.implement({ dashboard: dashboardHandlers })

async function ignoreConflict(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if ((error as { code?: string }).code !== 'CONFLICT') throw error
  }
}

if (process.env.BOOTSTRAP === 'true') {
  for (let index = 1; index <= 8; index++) {
    const reportId = `bootstrap-${String(index).padStart(2, '0')}`
    await ignoreConflict(() =>
      queueKit.enqueue('report', { reportId, source: 'bootstrap' }, { id: reportId }),
    )
  }
  await ignoreConflict(() =>
    queueKit.schedules.create({
      id: 'report-every-minute',
      queue: 'report',
      cron: '* * * * *',
      timezone: 'UTC',
      input: { reportId: 'scheduled-report', source: 'cron' },
      misfirePolicy: 'latest',
      overlapPolicy: 'skip',
    }),
  )
}

await new Promise<void>((resolve) => httpServer.listen(port, '0.0.0.0', resolve))
console.log(`[${nodeName}] ready as ${nodeKey} on :${port} using ${pgUrl}`)

const statusTimer = setInterval(async () => {
  const jobs = await queueKit.list()
  const counts = new Map<string, number>()
  for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1)
  console.log(
    `[${nodeName}] jobs queued=${counts.get('queued') ?? 0} running=${counts.get('running') ?? 0} completed=${counts.get('completed') ?? 0} failed=${counts.get('failed') ?? 0}`,
  )
}, 5_000)

let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  clearInterval(statusTimer)
  console.log(`[${nodeName}] shutting down`)
  await server.close()
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  )
  await collections.close?.()
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
