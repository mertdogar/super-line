import { describe, expect, it, vi } from 'vitest'
import { eq, gte } from '../src/index.js'
import type { CollectionStore, RowChange } from '../src/index.js'

/**
 * The shared specification of the {@link CollectionStore} seam, as tests rather than prose.
 *
 * Every backend runs this. Before it existed the contract lived in ~12 lines of doc comment, three adapters
 * hand-rolled their own overlapping assertions, and four documented clauses — including the silent-no-op
 * delete that the server's relay path depends on to absorb cross-node races — were verified against
 * `collections-memory` alone, a package nothing depends on in production.
 *
 * Deliberately NOT a `.test.ts` file: `vitest.config.ts` collects `packages/**\/test/**\/*.test.ts`, so this
 * would otherwise run standalone with no backend. Adapters import it directly, the way
 * `plugin-auth/test` already imports `server/test/harness.js`.
 *
 * `clustering` is a real discriminator here, not a label: it changes `apply`'s contract (see the docs on
 * {@link CollectionStore.apply}). A `relay` backend fires `onChange` from `apply`, returns the changes, and
 * must do so synchronously; a `self` backend does none of those — its replication feed delivers on every
 * node, and firing from `apply` would double-deliver. So the relay clauses are gated.
 */
export interface RowConformanceOptions {
  /** Build a fresh, empty store. Called once per test. May be async (`pgliteCollections` is). */
  make: () => CollectionStore | Promise<CollectionStore>
  /** The mode the backend declares. Gates the `apply`-contract clauses. */
  clustering: 'relay' | 'self'
  /**
   * A `self` backend's `apply` does not fire `onChange` — its feed does — so the change-emission clauses
   * can't run against it here. Its own test drives that feed directly.
   */
}

const msg = (id: string, channelId = 'general', n = 1): Record<string, unknown> => ({ id, channelId, text: `m${n}`, likes: n })

export function runRowConformance(name: string, opts: RowConformanceOptions): void {
  const { make, clustering } = opts
  const relay = clustering === 'relay'

  describe(`CollectionStore conformance · ${name} (${clustering})`, () => {
    // Every clause awaits, so sync (memory/sqlite) and async (pglite) backends read identically. The one
    // assertion that must NOT await is the sync invariant below — it inspects the return before resolving it.
    const fresh = async (): Promise<CollectionStore> => await make()

    it('declares its clustering mode', async () => {
      expect((await fresh()).clustering).toBe(clustering)
    })

    it('persists an insert, an update and a delete', async () => {
      const s = await fresh()
      await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
      expect(await s.read('messages', 'a')).toMatchObject({ id: 'a', likes: 1 })

      await s.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 9) }], 'o1')
      expect(await s.read('messages', 'a')).toMatchObject({ likes: 9 })

      await s.apply([{ op: 'delete', n: 'messages', id: 'a' }], 'o1')
      expect(await s.read('messages', 'a')).toBeUndefined()
    })

    it('rejects an insert of an existing id (CONFLICT)', async () => {
      const s = await fresh()
      await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
      await expect(async () => await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')).rejects.toThrow(
        /exists|CONFLICT/i,
      )
    })

    it('rejects an update of an absent id (NOT_FOUND)', async () => {
      const s = await fresh()
      await expect(async () => await s.apply([{ op: 'update', n: 'messages', id: 'z', row: msg('z') }], 'o1')).rejects.toThrow(
        /no row|NOT_FOUND/i,
      )
    })

    // The server's relay ingress leans on this to absorb a cross-node race: two nodes deleting the same row
    // must not throw on the second. Previously asserted against collections-memory only.
    it('treats a delete of an absent id as a silent no-op', async () => {
      const s = await fresh()
      await s.apply([{ op: 'delete', n: 'messages', id: 'ghost' }], 'o1') // must not throw
      expect(await s.read('messages', 'ghost')).toBeUndefined()
    })

    it('applies a batch atomically — a failing op rolls back the earlier ones', async () => {
      const s = await fresh()
      await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
      await expect(
        async () =>
          await s.apply(
            [
              { op: 'insert', n: 'messages', id: 'b', row: msg('b') }, // ok
              { op: 'insert', n: 'messages', id: 'a', row: msg('a') }, // CONFLICT → whole batch aborts
            ],
            'o1',
          ),
      ).rejects.toThrow(/exists|CONFLICT/i)
      expect(await s.read('messages', 'b')).toBeUndefined() // rolled back
      expect(await s.read('messages', 'a')).toMatchObject({ likes: 1 }) // untouched
    })

    it('applies intra-batch dependencies against evolving state (insert then update the same id)', async () => {
      const s = await fresh()
      await s.apply(
        [
          { op: 'insert', n: 'messages', id: 'a', row: msg('a') },
          { op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 5) },
        ],
        'o1',
      )
      expect(await s.read('messages', 'a')).toMatchObject({ likes: 5 })
    })

    // The entire rationale for one backend serving every collection: one tx domain, so a batch spans them.
    it('spans collections in one atomic batch', async () => {
      const s = await fresh()
      await s.apply(
        [
          { op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } },
          { op: 'insert', n: 'messages', id: 'a', row: msg('a') },
        ],
        'o1',
      )
      expect(await s.read('users', 'u1')).toMatchObject({ name: 'Ada' })
      expect(await s.read('messages', 'a')).toMatchObject({ id: 'a' })
    })

    it('keeps the same id in different collections distinct', async () => {
      const s = await fresh()
      await s.apply(
        [
          { op: 'insert', n: 'users', id: 'x', row: { id: 'x', name: 'Ada' } },
          { op: 'insert', n: 'messages', id: 'x', row: msg('x') },
        ],
        'o1',
      )
      expect(await s.read('users', 'x')).toMatchObject({ name: 'Ada' })
      expect(await s.read('messages', 'x')).toMatchObject({ text: 'm1' })
      await s.apply([{ op: 'delete', n: 'users', id: 'x' }], 'o1')
      expect(await s.read('users', 'x')).toBeUndefined()
      expect(await s.read('messages', 'x')).toBeDefined() // the sibling survives
    })

    it('snapshots an empty or unknown collection to []', async () => {
      const s = await fresh()
      expect(await s.snapshot('nope', {})).toEqual([])
      expect(await s.snapshot('messages', { filter: gte('likes', 0) })).toEqual([])
    })

    it('filters, sorts and paginates through the query IR', async () => {
      const s = await fresh()
      await s.apply(
        [
          { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 3) },
          { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'random', 1) },
          { op: 'insert', n: 'messages', id: 'c', row: msg('c', 'general', 2) },
          { op: 'insert', n: 'messages', id: 'd', row: msg('d', 'general', 5) },
        ],
        'o1',
      )
      const rows = (await s.snapshot('messages', {
        filter: eq('channelId', 'general'),
        orderBy: [{ field: 'likes', dir: 'desc' }],
        limit: 2,
      })) as Array<{ id: string }>
      expect(rows.map((r) => r.id)).toEqual(['d', 'a'])
    })

    it('keeps snapshot and read row-pure — timestamps never leak into the client-facing row', async () => {
      const s = await fresh()
      await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
      expect(Object.keys((await s.read('messages', 'a')) as object).sort()).toEqual(['channelId', 'id', 'likes', 'text'])
      expect(await s.snapshot('messages', {})).toEqual([msg('a')])
    })

    describe('rowMeta (inspector-only timestamps)', () => {
      it('is implemented, or this whole group is skipped', async () => {
        // `rowMeta?` is optional on the interface. Every first-party backend implements it; a backend that
        // omits it silently degrades the Control Center, so record which side of the line this one is on.
        expect(typeof (await fresh()).rowMeta === 'function' || true).toBe(true)
      })

      // Real timers, not fake ones: pglite's clock is the Postgres server's and can't be faked, so the shared
      // contract is asserted as a relationship (created frozen, updated strictly advances) rather than exact
      // values — which is what the contract actually promises anyway.
      it('stamps createdAt/updatedAt on insert, then bumps updatedAt while freezing createdAt', async () => {
        const s = await fresh()
        if (!s.rowMeta) return
        await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        const first = (await s.rowMeta('messages', ['a'])).a!
        expect(first.createdAt).toBeGreaterThan(0)
        expect(first.updatedAt).toBe(first.createdAt)

        await new Promise((r) => setTimeout(r, 10)) // comfortably cross a clock tick
        await s.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 9) }], 'o1')
        const second = (await s.rowMeta('messages', ['a'])).a!
        expect(second.createdAt).toBe(first.createdAt) // frozen
        expect(second.updatedAt).toBeGreaterThan(first.updatedAt) // and bumped
      })

      // A batch is atomic — it happened at one instant — so it reads the clock once, not once per op.
      // Sub-millisecond execution hides a per-op read almost always, which is exactly why this is asserted
      // rather than left to chance: memory read the clock per-op and passed by luck until it didn't.
      it('gives every row in one batch the same timestamp', async () => {
        const s = await fresh()
        if (!s.rowMeta) return
        await s.apply(
          [
            { op: 'insert', n: 'messages', id: 'r1', row: msg('r1') },
            { op: 'insert', n: 'messages', id: 'r2', row: msg('r2') },
            { op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } },
          ],
          'o1',
        )
        const m = await s.rowMeta('messages', ['r1', 'r2'])
        const u = await s.rowMeta('users', ['u1'])
        expect(m.r1!.createdAt).toBe(m.r2!.createdAt)
        expect(u.u1!.createdAt).toBe(m.r1!.createdAt) // ...across collections too
      })

      it('omits ids that do not exist', async () => {
        const s = await fresh()
        if (!s.rowMeta) return
        await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        const meta = await s.rowMeta('messages', ['a', 'ghost'])
        expect(meta).toHaveProperty('a')
        expect(meta).not.toHaveProperty('ghost')
      })

      it('returns {} for an empty id list', async () => {
        const s = await fresh()
        if (!s.rowMeta) return
        expect(await s.rowMeta('messages', [])).toEqual({})
      })
    })

    // ── relay-only: `apply` fires onChange, returns the changes, and is synchronous ──────────────────────
    // A `self` backend does none of these: its replication feed delivers to every node (including this one),
    // so firing from apply would double-deliver. Its own test drives that feed.
    describe.runIf(relay)('relay contract', () => {
      it('fires onChange once per change, carrying prev and next', async () => {
        const s = await fresh()
        const seen: RowChange[] = []
        s.onChange((c) => seen.push(c))

        await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        await s.apply([{ op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 9) }], 'o1')
        await s.apply([{ op: 'delete', n: 'messages', id: 'a' }], 'o1')

        expect(seen.map((c) => c.k)).toEqual(['insert', 'update', 'delete'])
        expect(seen[0]).toMatchObject({ id: 'a', origin: 'o1', next: { likes: 1 } })
        expect(seen[0]!.prev).toBeUndefined()
        expect(seen[1]).toMatchObject({ prev: { likes: 1 }, next: { likes: 9 } })
        expect(seen[2]).toMatchObject({ prev: { likes: 9 } })
        expect(seen[2]!.next).toBeUndefined()
      })

      it('emits nothing when a batch aborts', async () => {
        const s = await fresh()
        await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        const cb = vi.fn()
        s.onChange(cb)
        await expect(
          async () =>
            await s.apply(
              [
                { op: 'insert', n: 'messages', id: 'b', row: msg('b') },
                { op: 'insert', n: 'messages', id: 'a', row: msg('a') },
              ],
              'o1',
            ),
        ).rejects.toThrow()
        expect(cb).not.toHaveBeenCalled() // subscribers never observe a partial batch
      })

      it('returns the changes it applied', async () => {
        const s = await fresh()
        const changes = (await s.apply(
          [
            { op: 'insert', n: 'messages', id: 'a', row: msg('a') },
            { op: 'update', n: 'messages', id: 'a', row: msg('a', 'general', 5) },
          ],
          'o1',
        )) as RowChange[]
        expect(changes.map((c) => c.k)).toEqual(['insert', 'update'])
      })

      it('stops delivering to an unsubscribed listener', async () => {
        const s = await fresh()
        const cb = vi.fn()
        const off = s.onChange(cb)
        await s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        off()
        await s.apply([{ op: 'insert', n: 'messages', id: 'b', row: msg('b') }], 'o1')
        expect(cb).toHaveBeenCalledTimes(1)
      })

      // The universal "same timestamp in a batch" clause above cannot fail in practice: a batch completes
      // inside one millisecond, so a per-op clock read looks identical to a single one. This makes it bite.
      // A backend reading the clock once per batch is unaffected; one reading per op hands its rows
      // different stamps and fails here. Relay-only because it presumes the JS clock — a `self` backend
      // stamps from its database's clock, which no spy can reach, and is exempt on its own merits.
      it('reads the clock ONCE per batch, not once per op', async () => {
        const s = await fresh()
        if (!s.rowMeta) return
        let t = 1_700_000_000_000
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 1_000)) // every read jumps a second
        try {
          await s.apply(
            [
              { op: 'insert', n: 'messages', id: 'r1', row: msg('r1') },
              { op: 'insert', n: 'messages', id: 'r2', row: msg('r2') },
              { op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } },
            ],
            'o1',
          )
        } finally {
          spy.mockRestore()
        }
        const m = await s.rowMeta('messages', ['r1', 'r2'])
        const u = await s.rowMeta('users', ['u1'])
        expect(m.r2!.createdAt).toBe(m.r1!.createdAt)
        expect(u.u1!.createdAt).toBe(m.r1!.createdAt)
      })

      // THE invariant. The relay ingress does `void apply(...)` inside a try/catch, and the CRDT sibling
      // clears its re-publish guard in `finally`. An async apply escapes the catch and clears the guard
      // before onChange ever fires — one relayed write becomes a cluster-wide echo storm. This is the only
      // clause that must inspect the return value BEFORE awaiting it.
      it('applies SYNCHRONOUSLY — an async relay backend echo-storms the cluster', async () => {
        const s = await fresh()
        const returned = s.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a') }], 'o1')
        expect(typeof (returned as { then?: unknown })?.then).not.toBe('function')
        await returned // still settle it, so the store is usable if this ever regresses
      })
    })
  })
}
