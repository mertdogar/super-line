import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { createInspector, type InspectorClient } from '../src/lib/inspector-client.js'

const contract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const thingsContract = defineContract({
  collections: { things: { schema: z.object({ id: z.string(), n: z.number() }), key: 'id' } },
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function startServer() {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(contract, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    plugins: [inspector()],
  })
  srv.implement({ user: { ping: async () => 1 } })
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const { port } = httpServer.address() as AddressInfo
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })
  return { srv, url: `ws://127.0.0.1:${port}` }
}

/** The memory backend, with the *return* of each snapshot delayed by `hold` — the real window between the
 * server reading rows and the client applying them, made deterministic so the race is reproducible. */
function heldCollections(hold: () => Promise<void> | undefined) {
  const base = memoryCollections()
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'snapshot') {
        return async (n: string, query: unknown) => {
          const rows = await (target as { snapshot: (n: string, q: unknown) => unknown }).snapshot(n, query)
          await hold()
          return rows
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function startThingsServer(hold: () => Promise<void> | undefined = () => undefined) {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(thingsContract, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    collections: heldCollections(hold),
    plugins: [inspector()],
  })
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const { port } = httpServer.address() as AddressInfo
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })
  return { srv, url: `ws://127.0.0.1:${port}` }
}

function whenOpen(insp: InspectorClient): Promise<void> {
  return new Promise((resolve) => {
    const off = insp.onStatus((s) => {
      if (s === 'open') {
        off()
        resolve()
      }
    })
  })
}

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('inspector client', () => {
  it('connects and queries topology / connections / contract', async () => {
    const { srv, url } = await startServer()
    const user = createSuperLineClient(contract, { transport: webSocketClientTransport({ url }), role: 'user' })
    cleanups.push(() => user.close())
    await user.ping() // a node only appears in topology once it holds a connection

    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)

    const topology = await insp.getTopology()
    expect(topology).toHaveLength(1)
    expect(topology[0]?.nodeId).toBe(srv.nodeId)
    expect(topology[0]?.connections).toBe(1) // the inspector itself is not counted

    const conns = await insp.listConnections()
    expect(conns).toHaveLength(1)
    expect(conns[0]?.role).toBe('user')

    const contractView = await insp.getContract()
    expect(Object.keys(contractView.roles)).toContain('user')
  })

  it('receives live connect events', async () => {
    const { url } = await startServer()
    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)
    await insp.getNode() // flush: ensures the events subscribe frame was processed first (in-order)

    const types: string[] = []
    insp.onEvent((en) => types.push(en.event.type))

    const user = createSuperLineClient(contract, { transport: webSocketClientTransport({ url }), role: 'user' })
    cleanups.push(() => user.close())
    await user.ping()

    await waitFor(() => types.includes('connect'))
    expect(types).toContain('connect')
  })

  it('subscribeCollection: snapshots then folds in live changes', async () => {
    const { srv, url } = await startThingsServer()
    await srv.collection('things').insert({ id: 'a', n: 1 })

    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)
    await insp.getNode() // flush: the events subscribe frame is processed before anything below

    const sub = insp.subscribeCollection('things')
    const things = (): Array<{ id: string; n: number }> =>
      sub.rows().map((r) => ({ id: (r as { id: string }).id, n: (r as { n: number }).n }))

    await sub.ready
    // Snapshot rows carry the inspector's `_createdAt`/`_updatedAt` meta; rows that arrive as changes do not,
    // so consumers must read fields off the schema, never the meta.
    expect(sub.rows()[0]).toMatchObject({ id: 'a', n: 1 })
    expect(things()).toEqual([{ id: 'a', n: 1 }])

    await srv.collection('things').insert({ id: 'b', n: 2 })
    await waitFor(() => sub.rows().length === 2)

    await srv.collection('things').update({ id: 'b', n: 20 })
    await waitFor(() => sub.rows().some((r) => (r as { n: number }).n === 20))

    await srv.collection('things').delete('a')
    await waitFor(() => sub.rows().length === 1)
    expect(things()).toEqual([{ id: 'b', n: 20 }])
  })

  // A change committed after the server reads the snapshot but before the client applies it arrives as an
  // event *first*. Applying the snapshot must fold that change in, not overwrite it — otherwise a job that
  // settles during page load stays stale in the table until it happens to change again.
  it('subscribeCollection: a change racing the initial snapshot is not lost', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let snapshotRead!: () => void
    const wasRead = new Promise<void>((resolve) => {
      snapshotRead = resolve
    })
    let holding = false
    const { srv, url } = await startThingsServer(() => {
      if (!holding) return undefined
      snapshotRead() // the server has read the rows; the reply is now parked on `held`
      return held
    })

    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)
    await insp.getNode()

    let changes = 0
    insp.onEvent((en) => {
      if (en.event.type === 'collection.change') changes++
    })

    holding = true
    const sub = insp.subscribeCollection('things')
    await wasRead // the snapshot is now a committed-empty read, parked before its reply
    await srv.collection('things').insert({ id: 'a', n: 1 })
    await waitFor(() => changes === 1) // the change reached the client while the snapshot is still in flight

    release() // the (now stale, empty) snapshot lands
    await sub.ready

    expect(sub.rows()).toHaveLength(1)
    expect(sub.rows()[0]).toMatchObject({ id: 'a', n: 1 })
  })
})
