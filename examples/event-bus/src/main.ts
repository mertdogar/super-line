import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { bus } from './contract.js'

// One process, one server node — the cluster event bus working *within* a single instance.
// `server.publish` reaches every `server.subscribe` in the process (local echo, in-process,
// no network hop) AND any connected client that subscribed. The same code scales to many
// nodes just by passing a Redis adapter; see examples/bus-cluster.
async function main(): Promise<void> {
  const server = http.createServer()
  const srv = createSuperLineServer(bus, {
    server,
    authenticate: () => ({ role: 'watcher' as const, ctx: {} }),
  })

  // "anyone within the instance can subscribe" — two unrelated parts of the app both listen,
  // and both fire in-process. `meta.from` is the origin node id (here, always us).
  srv.subscribe('announce', (a, { from }) => {
    const origin = from === srv.nodeId ? 'self (local echo, in-process)' : from
    console.log(`  [metrics] announce "${a.text}"  (origin: ${origin})`)
  })
  srv.subscribe('announce', (a) => {
    console.log(`  [audit]   announce "${a.text}"`)
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  // a connected client subscribes to the same event — delivered over the WebSocket.
  const client = createSuperLineClient(bus, { url, role: 'watcher' })
  await client.subscribe('announce', (a) => console.log(`  [client]  announce "${a.text}"`)).ready

  // one publish from the server fans out to BOTH in-process subscribers (synchronously, no hop)
  // and the client over WS. No Redis needed — this is a single node.
  console.log('publishing "maintenance at 5pm"…')
  srv.publish('announce', { text: 'maintenance at 5pm' })

  await new Promise((resolve) => setTimeout(resolve, 200))

  client.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
