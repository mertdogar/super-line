import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSuperLineServer, MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { ops } from './contract.js'

// One-command demo, NO external services. It boots TWO nodes that share one
// in-memory MemoryBus (the same trick the test suite uses to simulate a cluster
// in a single process). It then shows the new server-side toolkit:
//   • cluster introspection — count / topology / isOnline across nodes
//   • targeted cross-node send — toUser(...).emit from a node that doesn't hold the socket
//   • server→client request — a node asks a client a question and awaits the typed reply
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

// auth reads the user id from the query string; identify exposes it to the cluster registry
function authenticate(req: { url?: string }) {
  const uid = new URL(req.url ?? '', 'http://localhost').searchParams.get('uid') ?? 'anon'
  return { role: 'user' as const, ctx: { userId: uid } }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

async function node(bus: MemoryBus) {
  const server = http.createServer()
  const srv = createSuperLineServer(ops, {
    server,
    authenticate,
    identify,
    describeConn: (conn) => ({ userId: (conn.ctx as { userId: string }).userId }),
    adapter: createInMemoryAdapter(bus), // same bus on both nodes => one logical cluster
  })
  srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  await new Promise<void>((r) => server.listen(0, r))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => {
    await srv.close()
    await new Promise<void>((r) => server.close(() => r()))
  }
  return { srv, url, close }
}

async function main(): Promise<void> {
  const bus = new MemoryBus()
  const a = await node(bus)
  const b = await node(bus)
  console.log(`node A: ${a.url}  (id ${a.srv.nodeId.slice(0, 8)})`)
  console.log(`node B: ${b.url}  (id ${b.srv.nodeId.slice(0, 8)})\n`)

  // alice connects to node A, bob to node B. alice answers server→client `confirm` requests.
  const alice = createSuperLineClient(ops, { url: a.url, role: 'user', params: { uid: 'alice' } })
  const notices: string[] = []
  alice.on('notice', (n) => {
    notices.push(n.text)
    console.log(`  alice@A received notice: "${n.text}"`)
  })
  alice.implement({
    confirm: async ({ question }) => {
      console.log(`  alice@A was asked: "${question}" -> approving`)
      return { approved: true }
    },
  })
  const bob = createSuperLineClient(ops, { url: b.url, role: 'user', params: { uid: 'bob' } })
  await Promise.all([alice.hello({}), bob.hello({})])
  await tick(50) // let both presence registrations settle

  // 1) cluster introspection — node B sees the whole cluster, including alice on node A
  console.log('— cluster introspection (asked on node B) —')
  console.log(`  cluster count: ${await b.srv.cluster.count()}`)
  console.log(`  isOnline(alice): ${await b.srv.isOnline('alice')}`)
  const topo = await b.srv.cluster.topology()
  for (const n of topo) console.log(`  node ${n.nodeId.slice(0, 8)}: ${n.connections} conn(s), alive=${n.alive}`)

  // 2) targeted cross-node send — node B reaches alice even though node A holds her socket
  console.log('\n— targeted cross-node send (from node B) —')
  b.srv.toUser('alice').emit('notice', { text: 'hello from node B' })
  await tick(50)

  // 3) server→client request — node B asks alice and awaits her typed answer
  console.log('\n— server→client request (from node B) —')
  const [aliceConn] = await b.srv.cluster.byUser('alice')
  const answer = await b.srv.toConn(aliceConn!.id).request('confirm', { question: 'Deploy now?' })
  console.log(`  node B got alice's reply: approved=${answer.approved}`)

  const ok =
    (await b.srv.cluster.count()) === 2 &&
    notices.length === 1 &&
    answer.approved === true &&
    topo.length === 2
  console.log(`\nnew server toolkit across nodes: ${ok ? 'OK ✓' : 'FAILED ✗'}`)

  alice.close()
  bob.close()
  await a.close()
  await b.close()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
