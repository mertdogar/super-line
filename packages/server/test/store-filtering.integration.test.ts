import type { ResourceSummary } from '@super-line/core'
import { defineContract } from '@super-line/core'
import { memoryStoreServer } from '@super-line/store-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { inspector as inspectorPlugin } from '@super-line/plugin-inspector'
import { connectInspector, createHarness, tick } from './harness.js'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })

// Seed: mixed id prefixes (doc-/note-) and varied grants so idContains, OR-union principals,
// principalCount, and sort each have something to bite on.
//   doc-alpha  → alice(rw) bob(r)   count 2
//   doc-beta   → alice(rw)          count 1
//   note-gamma → bob(rw)  carol(r)  count 2
//   doc-delta  → carol(rw)          count 1
// principals across the store: alice, bob, carol
async function seed(srv: { store: (n: string) => { create: (id: string, data: unknown, acl: unknown) => Promise<void> } }) {
  const s = srv.store('docs')
  await s.create('doc-alpha', { v: 1 }, { alice: { read: true, write: true }, bob: { read: true, write: false } })
  await s.create('doc-beta', { v: 1 }, { alice: { read: true, write: true } })
  await s.create('note-gamma', { v: 1 }, { bob: { read: true, write: true }, carol: { read: true, write: false } })
  await s.create('doc-delta', { v: 1 }, { carol: { read: true, write: true } })
}

const ids = (rows: ResourceSummary[]): string[] => rows.map((r) => r.id)

describe('store filtering RPCs (list(opts) + searchPrincipals via the inspector)', () => {
  const h = createHarness()
  afterEach(() => h.dispose())

  async function boot() {
    const { srv, url } = await h.server(contract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [inspectorPlugin()],
      stores: { docs: memoryStoreServer() },
    })
    await seed(srv)
    const inspector = await connectInspector(url)
    const list = (opts?: unknown) =>
      inspector.request('listResources', { store: 'docs', ...(opts as object) }) as Promise<ResourceSummary[]>
    const search = (opts?: unknown) =>
      inspector.request('searchPrincipals', { store: 'docs', ...(opts as object) }) as Promise<string[]>
    return { srv, inspector, list, search }
  }

  it('returns ResourceSummary rows: id + principalCount + non-null timestamps', async () => {
    const { inspector, list } = await boot()
    const rows = await list({ sort: { by: 'id', dir: 'asc' } })
    expect(ids(rows)).toEqual(['doc-alpha', 'doc-beta', 'doc-delta', 'note-gamma'])
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['doc-alpha'].principalCount).toBe(2)
    expect(byId['doc-beta'].principalCount).toBe(1)
    expect(byId['note-gamma'].principalCount).toBe(2)
    expect(byId['doc-delta'].principalCount).toBe(1)
    for (const r of rows) {
      expect(r.createdAt).toBeGreaterThan(0)
      expect(r.updatedAt).toBeGreaterThanOrEqual(r.createdAt)
    }
    inspector.close()
  })

  it('idContains is a substring filter on id', async () => {
    const { inspector, list } = await boot()
    const rows = await list({ idContains: 'doc', sort: { by: 'id', dir: 'asc' } })
    expect(ids(rows)).toEqual(['doc-alpha', 'doc-beta', 'doc-delta']) // note-gamma excluded
    inspector.close()
  })

  it('principals filters by OR / union (grants ANY selected)', async () => {
    const { inspector, list } = await boot()
    const alice = await list({ principals: ['alice'], sort: { by: 'id', dir: 'asc' } })
    expect(ids(alice)).toEqual(['doc-alpha', 'doc-beta'])
    // alice ∪ bob → alpha(alice,bob), beta(alice), gamma(bob)
    const union = await list({ principals: ['alice', 'bob'], sort: { by: 'id', dir: 'asc' } })
    expect(ids(union)).toEqual(['doc-alpha', 'doc-beta', 'note-gamma'])
    inspector.close()
  })

  it('idContains ∧ principals compose (AND across facets)', async () => {
    const { inspector, list } = await boot()
    // bob grants {doc-alpha, note-gamma}; idContains 'doc' keeps only doc-alpha
    const rows = await list({ idContains: 'doc', principals: ['bob'] })
    expect(ids(rows)).toEqual(['doc-alpha'])
    inspector.close()
  })

  it('sorts by principalCount desc', async () => {
    const { inspector, list } = await boot()
    const rows = await list({ sort: { by: 'principalCount', dir: 'desc' } })
    expect(rows.map((r) => r.principalCount)).toEqual([2, 2, 1, 1]) // tie order unspecified; counts are what matter
    inspector.close()
  })

  it('sorts by updatedAt desc — most-recently-mutated first', async () => {
    const { srv, inspector, list } = await boot()
    await tick() // separate the timestamp from the seed creates
    await srv.store('docs').grant('doc-beta', 'zoe', { read: true, write: false }) // setAccess bumps updatedAt
    const rows = await list({ sort: { by: 'updatedAt', dir: 'desc' } })
    expect(rows[0].id).toBe('doc-beta')
    inspector.close()
  })

  it('paginates with limit/offset (id asc), and returns all rows when limit is omitted', async () => {
    const { inspector, list } = await boot()
    const asc = { sort: { by: 'id', dir: 'asc' } as const }
    expect(ids(await list({ ...asc, limit: 2, offset: 0 }))).toEqual(['doc-alpha', 'doc-beta'])
    expect(ids(await list({ ...asc, limit: 2, offset: 2 }))).toEqual(['doc-delta', 'note-gamma'])
    expect(ids(await list(asc))).toHaveLength(4) // limit omitted ⇒ unbounded
    inspector.close()
  })

  it('searchPrincipals: store-global, substring, principal ASC', async () => {
    const { inspector, search } = await boot()
    expect(await search()).toEqual(['alice', 'bob', 'carol']) // no query ⇒ all, sorted asc
    expect(await search({ query: 'a' })).toEqual(['alice', 'carol']) // substring, not bob
    expect(await search({ query: 'bo' })).toEqual(['bob'])
    inspector.close()
  })

  it('searchPrincipals paginates in a stable principal-asc order', async () => {
    const { inspector, search } = await boot()
    expect(await search({ limit: 1, offset: 0 })).toEqual(['alice'])
    expect(await search({ limit: 1, offset: 1 })).toEqual(['bob'])
    expect(await search({ limit: 1, offset: 2 })).toEqual(['carol'])
    inspector.close()
  })
})
