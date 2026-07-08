import { execSync } from 'node:child_process'
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers'
import type { CrdtCollectionStore, DocOptions } from '@super-line/core'
import { crdtPgliteCollections } from '@super-line/collections-crdt-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// Real end-to-end: two `crdtPgliteCollections` nodes (each with its OWN in-memory PGlite replica) against ONE
// central Postgres + a real ElectricSQL service. Unlike the unit suite (which hand-INSERTs op-log rows to fake
// the feed), this exercises the actual cross-node bus — a co-writer's Yjs delta is appended to central, Electric
// streams it to the other node's replica keyed by (collection, id), and that node folds it in. Proves the CRDT
// claim: concurrent co-writes on different nodes MERGE, they don't clobber. Requires Docker; skipped when absent.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const docMode: DocOptions = { mode: 'document' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(50)
  }
}
// CRDT merge converges on VALUE but not on key ORDER — canonicalize (recursively sort keys) before comparing.
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
  // The backend runs in THIS process, so it dials the mapped host ports (not the in-network aliases).
  pgUrl = `postgres://postgres:password@${pg.getHost()}:${pg.getMappedPort(5432)}/electric`
  electricUrl = `http://${electric.getHost()}:${electric.getMappedPort(3000)}/v1/shape`
}, 240_000)

afterAll(async () => {
  await electric?.stop()
  await pg?.stop()
  await network?.stop()
})

let seq = 0
const stores: CrdtCollectionStore[] = []
async function node(table: string): Promise<CrdtCollectionStore> {
  const store = await crdtPgliteCollections({ pgUrl, electricUrl, docOptions: () => docMode, table })
  stores.push(store)
  return store
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close?.()
})

describe.skipIf(!dockerAvailable)('collections-crdt-pglite — co-writers over real Electric (2 nodes)', () => {
  it('concurrent co-writes on different nodes MERGE — no clobber', async () => {
    const table = `crdt_${seq++}`
    const a = await node(table)
    const b = await node(table)

    await a.create('scenes', 'board', { shapes: {} }, docMode)
    // Strong-fold the seed into BOTH nodes before opening co-writers, so each replica's Yjs doc shares the
    // creator's seed state (open() is synchronous and won't await Electric).
    await waitFor(async () => (await a.read('scenes', 'board')) !== undefined)
    await waitFor(async () => (await b.read('scenes', 'board')) !== undefined)

    const ra = a.open('scenes', 'board', { origin: 'agent:1' })
    const rb = b.open('scenes', 'board', { origin: 'agent:2' })

    // Concurrent writes to the SAME board on DIFFERENT nodes (different shapes).
    ra.update({ shapes: { S1: { x: 10, y: 20 } } })
    rb.update({ shapes: { S2: { x: 1, y: 2 } } })

    const merged = { shapes: { S1: { x: 10, y: 20 }, S2: { x: 1, y: 2 } } }
    // Each node converges only once Electric delivers the OTHER node's delta and it folds in.
    await waitFor(() => sameDoc(a.open('scenes', 'board').getSnapshot(), merged))
    await waitFor(() => sameDoc(b.open('scenes', 'board').getSnapshot(), merged))

    expect(a.open('scenes', 'board').getSnapshot()).toEqual(merged)
    expect(b.open('scenes', 'board').getSnapshot()).toEqual(merged)

    ra.close()
    rb.close()
  }, 60_000)

  it('a co-writer delete(path) on one node propagates to the other', async () => {
    const table = `crdt_${seq++}`
    const a = await node(table)
    const b = await node(table)

    await a.create('scenes', 'board', { shapes: { S1: { x: 1 }, S2: { x: 2 } } }, docMode)
    await waitFor(async () => (await a.read('scenes', 'board')) !== undefined)
    await waitFor(async () => sameDoc((await b.read('scenes', 'board')) && b.open('scenes', 'board').getSnapshot(), { shapes: { S1: { x: 1 }, S2: { x: 2 } } }))

    const ra = a.open('scenes', 'board', { origin: 'agent:1' })
    ra.delete(['shapes', 'S1']) // surgical CRDT key removal on node A

    await waitFor(() => sameDoc(b.open('scenes', 'board').getSnapshot(), { shapes: { S2: { x: 2 } } }))
    expect(b.open('scenes', 'board').getSnapshot()).toEqual({ shapes: { S2: { x: 2 } } })

    ra.close()
  }, 60_000)

  it('a deleted document propagates as onDelete to the other node', async () => {
    const table = `crdt_${seq++}`
    const a = await node(table)
    const b = await node(table)

    await a.create('scenes', 'gone', { v: 1 }, docMode)
    await waitFor(async () => (await b.read('scenes', 'gone')) !== undefined)

    const bDeletes: Array<[string, string]> = []
    b.onDelete?.((n, id) => bDeletes.push([n, id]))
    await a.delete('scenes', 'gone')

    await waitFor(() => bDeletes.some(([n, id]) => n === 'scenes' && id === 'gone'))
    expect(await b.read('scenes', 'gone')).toBeUndefined()
  }, 60_000)
})
