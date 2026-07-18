import { execSync } from 'node:child_process'
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers'
import { z } from 'zod'
import type { CollectionDef, RowChange, SelfCollectionStore } from '@super-line/core'
import { pgliteCollections } from '@super-line/collections-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// Real end-to-end for the LWW row tier: two `pgliteCollections` nodes (each with its OWN in-memory PGlite
// replica) against ONE central Postgres + a real ElectricSQL service. The unit suite hand-feeds the replica;
// this exercises the actual bus — a write lands in central Postgres, Electric streams it to EVERY node's
// replica, and each node's live.changes feed becomes onChange. It pins the contract typed-column work must
// preserve (PLAN-collections-typed-tables.md Phase 2a): `next` is always the COMPLETE row (the server's
// enter/leave routing and TanStack's rowUpdateMode:'full' both depend on it), origin survives the round-trip,
// and deletes arrive prev-less. Requires Docker; skipped when absent.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(50)
  }
}

let network: StartedNetwork
let pg: StartedTestContainer
let electric: StartedTestContainer
let pgUrl: string
let electricUrl: string

beforeAll(async () => {
  if (!dockerAvailable) return
  network = await new Network().start()
  pg = await new GenericContainer('postgres:16')
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .withEnvironment({ POSTGRES_DB: 'electric', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'password' })
    .withCommand(['-c', 'wal_level=logical'])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  electric = await new GenericContainer('electricsql/electric')
    .withNetwork(network)
    .withEnvironment({ DATABASE_URL: 'postgresql://postgres:password@postgres:5432/electric?sslmode=disable', ELECTRIC_INSECURE: 'true' })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/v1/health', 3000).forStatusCode(200))
    .start()
  pgUrl = `postgres://postgres:password@${pg.getHost()}:${pg.getMappedPort(5432)}/electric`
  electricUrl = `http://${electric.getHost()}:${electric.getMappedPort(3000)}/v1/shape`
}, 240_000)

afterAll(async () => {
  await electric?.stop()
  await pg?.stop()
  await network?.stop()
})

const defs: Record<string, CollectionDef> = {
  messages: { schema: z.object({ id: z.string(), channelId: z.string(), likes: z.number() }), key: 'id' },
  users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  // camelCase name → case-sensitive table identifier; pins that the Electric shape param is quoted to match the DDL
  passwordResets: { schema: z.object({ id: z.string(), token: z.string() }), key: 'id' },
}

let seq = 0
const stores: SelfCollectionStore[] = []
async function node(tablePrefix: string): Promise<{ store: SelfCollectionStore; seen: RowChange[] }> {
  const store = await pgliteCollections({ pgUrl, electricUrl, collections: defs, tablePrefix })
  stores.push(store)
  const seen: RowChange[] = []
  store.onChange((c) => seen.push(c))
  return { store, seen }
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close?.()
})

const row = (id: string, likes: number, extra: Record<string, unknown> = {}) => ({ id, channelId: 'general', likes, ...extra })

describe.skipIf(!dockerAvailable)('collections-pglite — LWW rows over real Electric (2 nodes)', () => {
  it('delivers a write to every node as a COMPLETE row, with origin intact', async () => {
    const prefix = `r${seq++}_`
    const a = await node(prefix)
    const b = await node(prefix)

    await a.store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: row('m1', 1) }], 'o-a')

    // Both replicas — including the writer's own — hear it from the feed, never from apply.
    await waitFor(() => a.seen.some((c) => c.k === 'insert' && c.id === 'm1'))
    await waitFor(() => b.seen.some((c) => c.k === 'insert' && c.id === 'm1'))
    for (const s of [a, b]) {
      const ins = s.seen.find((c) => c.k === 'insert' && c.id === 'm1')!
      expect(ins).toMatchObject({ n: 'messages', origin: 'o-a' })
      expect(ins.next).toEqual(row('m1', 1)) // the full row, not a diff
    }

    // THE whole-row pin: an update that only bumps one field must still deliver the complete row.
    await b.store.apply([{ op: 'update', n: 'messages', id: 'm1', row: row('m1', 2) }], 'o-b')
    await waitFor(() => a.seen.some((c) => c.k === 'update' && c.id === 'm1'))
    await waitFor(() => b.seen.some((c) => c.k === 'update' && c.id === 'm1'))
    for (const s of [a, b]) {
      const upd = s.seen.find((c) => c.k === 'update' && c.id === 'm1')!
      expect(upd.origin).toBe('o-b')
      expect(upd.next).toEqual(row('m1', 2)) // complete row: channelId still present, not just likes
    }

    // Deletes arrive prev-less — routing broadcasts them to every subscriber.
    await a.store.apply([{ op: 'delete', n: 'messages', id: 'm1' }], 'o-a')
    await waitFor(() => a.seen.some((c) => c.k === 'delete' && c.id === 'm1'))
    await waitFor(() => b.seen.some((c) => c.k === 'delete' && c.id === 'm1'))
    for (const s of [a, b]) {
      const del = s.seen.find((c) => c.k === 'delete' && c.id === 'm1')!
      expect(del.n).toBe('messages')
      expect(del.prev).toBeUndefined()
      expect(del.next).toBeUndefined()
    }
  }, 60_000)

  it('serves strong reads from central regardless of feed lag, and keeps collections distinct', async () => {
    const prefix = `r${seq++}_`
    const a = await node(prefix)
    const b = await node(prefix)

    await a.store.apply(
      [
        { op: 'insert', n: 'messages', id: 'x', row: row('x', 5) },
        { op: 'insert', n: 'users', id: 'x', row: { id: 'x', name: 'Ada' } },
      ],
      'o-a',
    )

    // No Electric wait: snapshot/read/rowMeta hit central Postgres directly, even from the other node.
    expect(await b.store.read('messages', 'x')).toEqual(row('x', 5))
    expect(await b.store.read('users', 'x')).toEqual({ id: 'x', name: 'Ada' })
    expect(await b.store.snapshot('messages', {})).toEqual([row('x', 5)])
    const meta = (await b.store.rowMeta!('messages', ['x'])).x!
    expect(meta.createdAt).toBeGreaterThan(0)
    expect(meta.updatedAt).toBe(meta.createdAt)

    // The batch was cross-collection and atomic; both nodes converge via the feed too.
    await waitFor(() => b.seen.filter((c) => c.k === 'insert').length === 2)
    expect(b.seen.map((c) => c.n).sort()).toEqual(['messages', 'users'])
  }, 60_000)

  it('syncs camelCase collection tables (case-sensitive identifiers) through Electric', async () => {
    const prefix = `r${seq++}_`
    const a = await node(prefix)
    const b = await node(prefix)

    await a.store.apply([{ op: 'insert', n: 'passwordResets', id: 'pr1', row: { id: 'pr1', token: 't' } }], 'o-a')

    await waitFor(() => a.seen.some((c) => c.n === 'passwordResets' && c.k === 'insert' && c.id === 'pr1'))
    await waitFor(() => b.seen.some((c) => c.n === 'passwordResets' && c.k === 'insert' && c.id === 'pr1'))
    expect(b.seen.find((c) => c.n === 'passwordResets')!.next).toEqual({ id: 'pr1', token: 't' })
  }, 60_000)
})
