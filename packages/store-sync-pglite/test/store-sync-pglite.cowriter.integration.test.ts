import { execSync } from 'node:child_process'
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers'
import type { ServerStore } from '@super-line/core'
import { syncPgliteStoreServer, type DocOptions } from '@super-line/store-sync-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// Real end-to-end: two `syncPgliteStoreServer` nodes (each with its OWN in-memory PGlite replica) against ONE
// central Postgres + a real ElectricSQL service. Unlike the unit suite (which hand-INSERTs op-log rows to fake
// the feed), this exercises the actual cross-node bus — a co-writer's Yjs delta is appended to central, Electric
// streams it to the other node's replica, and that node folds it in. Proves the CRDT claim that makes co-writers
// worth it: concurrent co-writes on different nodes MERGE, they don't clobber. Requires Docker; skipped cleanly
// when absent (same as the adapter integration tests).
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const docMode: DocOptions = { mode: 'document' }
const resolveOptions = (): DocOptions => docMode

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(50)
  }
}
// CRDT merge converges on VALUE but not on key ORDER — node A may yield {S1,S2} while node B yields {S2,S1}.
// Canonicalize (recursively sort keys) before comparing, so a convergence wait isn't fooled by key order.
const canon = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      )
    : v
const sameDoc = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

let network: StartedNetwork
let pg: StartedTestContainer
let electric: StartedTestContainer
let pgUrl: string
let electricUrl: string

beforeAll(async () => {
  if (!dockerAvailable) return
  network = await new Network().start()
  // Central Postgres — wal_level=logical so Electric can replicate. `postgres` alias is how Electric dials it.
  pg = await new GenericContainer('postgres:16')
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .withEnvironment({ POSTGRES_DB: 'electric', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'password' })
    .withCommand(['-c', 'wal_level=logical'])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  // Electric — streams the op-log + meta tables out as HTTP shapes. /v1/health 200 = fully ready (202 while starting).
  electric = await new GenericContainer('electricsql/electric')
    .withNetwork(network)
    .withEnvironment({ DATABASE_URL: 'postgresql://postgres:password@postgres:5432/electric?sslmode=disable', ELECTRIC_INSECURE: 'true' })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/v1/health', 3000).forStatusCode(200))
    .start()
  // The store runs in THIS process, so it dials the mapped host ports (not the in-network aliases).
  pgUrl = `postgres://postgres:password@${pg.getHost()}:${pg.getMappedPort(5432)}/electric`
  electricUrl = `http://${electric.getHost()}:${electric.getMappedPort(3000)}/v1/shape`
}, 240_000)

afterAll(async () => {
  await electric?.stop()
  await pg?.stop()
  await network?.stop()
})

let seq = 0
const stores: ServerStore[] = []
async function node(table: string): Promise<ServerStore> {
  const store = await syncPgliteStoreServer({ pgUrl, electricUrl, resolveOptions, table })
  stores.push(store)
  return store
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close?.()
})

describe.skipIf(!dockerAvailable)('store-sync-pglite — co-writers over real Electric (2 nodes)', () => {
  it('concurrent co-writes on different nodes MERGE — no clobber', async () => {
    const table = `res_${seq++}`
    const a = await node(table)
    const b = await node(table)

    await a.create('board', { shapes: {} }, { agent: { read: true, write: true } })
    // Strong-fold the seed into BOTH nodes before opening co-writers, so each replica's Yjs doc shares the
    // creator's seed state (open() is synchronous and won't await Electric). This is the load-bearing pattern
    // the ai-canvas-pglite example uses; without it B would co-write into a divergent `shapes` map.
    await waitFor(async () => (await a.read('board')) !== undefined)
    await waitFor(async () => (await b.read('board')) !== undefined)

    const ra = a.open!('board', { origin: 'agent:1' })
    const rb = b.open!('board', { origin: 'agent:2' })

    // Concurrent writes to the SAME board on DIFFERENT nodes (different shapes).
    ra.update({ shapes: { S1: { x: 10, y: 20 } } })
    rb.update({ shapes: { S2: { x: 1, y: 2 } } })

    const merged = { shapes: { S1: { x: 10, y: 20 }, S2: { x: 1, y: 2 } } }
    // Each node converges only once Electric delivers the OTHER node's delta and it folds in.
    await waitFor(() => sameDoc(a.open!('board').getSnapshot(), merged))
    await waitFor(() => sameDoc(b.open!('board').getSnapshot(), merged))

    expect(a.open!('board').getSnapshot()).toEqual(merged)
    expect(b.open!('board').getSnapshot()).toEqual(merged)

    ra.close()
    rb.close()
  }, 60_000)

  it('a co-writer delete(path) on one node propagates to the other', async () => {
    const table = `res_${seq++}`
    const a = await node(table)
    const b = await node(table)

    await a.create('board', { shapes: { S1: { x: 1 }, S2: { x: 2 } } }, { agent: { read: true, write: true } })
    await waitFor(async () => (await a.read('board')) !== undefined)
    await waitFor(async () => sameDoc((await b.read('board')) && b.open!('board').getSnapshot(), { shapes: { S1: { x: 1 }, S2: { x: 2 } } }))

    const ra = a.open!('board', { origin: 'agent:1' })
    ra.delete(['shapes', 'S1']) // surgical CRDT key removal on node A

    await waitFor(() => sameDoc(b.open!('board').getSnapshot(), { shapes: { S2: { x: 2 } } }))
    expect(b.open!('board').getSnapshot()).toEqual({ shapes: { S2: { x: 2 } } })

    ra.close()
  }, 60_000)
})
