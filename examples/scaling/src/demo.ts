import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { createSocketServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { createClient } from '@super-line/client'
import { sync } from './contract.js'

// One-command demo: boots TWO independent nodes (separate http servers + separate
// Redis adapter connections) and a client connected to node A only. A publish/broadcast
// from node B reaches the client on node A — proving cross-process fan-out via Redis.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function requireRedis(): Promise<void> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  try {
    await probe.connect()
    await probe.quit()
  } catch {
    console.error(`\nThis demo needs Redis at ${REDIS_URL}.`)
    console.error('Start one with:  docker run --rm -p 6379:6379 redis:7\n')
    process.exit(1)
  }
}

async function node() {
  const server = http.createServer()
  const srv = createSocketServer(sync, {
    server,
    authenticate: () => ({}),
    adapter: createRedisAdapter(REDIS_URL),
  })
  srv.implement({
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      return { ok: true }
    },
  })
  await new Promise<void>((r) => server.listen(0, r))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => {
    await srv.close()
    await new Promise<void>((r) => server.close(() => r()))
  }
  return { srv, url, close }
}

async function main(): Promise<void> {
  await requireRedis()

  const a = await node()
  const b = await node()
  console.log(`node A: ${a.url}\nnode B: ${b.url}\n`)

  const client = createClient(sync, { url: a.url }) // connected to node A only
  const feed: number[] = []
  const msgs: string[] = []
  client.on('message', (m) => {
    msgs.push(m.text)
    console.log(`  client@A received room broadcast: "${m.text}"`)
  })
  await client.subscribe('feed', (p) => {
    feed.push(p.seq)
    console.log(`  client@A received topic feed: seq=${p.seq}`)
  }).ready
  await client.join({ room: 'room1' })
  await tick(200) // let node A's Redis SUBSCRIBE for the room channel register

  console.log('publishing from node B (a different process/node)...\n')
  b.srv.publish('feed', { seq: 1 })
  b.srv.room('room1').broadcast('message', { room: 'room1', text: 'hello from node B' })

  await tick(400)
  const ok = feed.length > 0 && msgs.length > 0
  console.log(`\ncross-node fan-out: topic=${feed.length} room=${msgs.length} -> ${ok ? 'OK ✓' : 'FAILED ✗'}`)

  client.close()
  await a.close()
  await b.close()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
