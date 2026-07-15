import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type {
  CollectionName,
  CollectionStore,
  RelayCollectionStore,
  ResolvedRowOp,
  RowOf,
  RowInputOf,
  CollectionsOf,
  SelfCollectionStore,
} from '@super-line/core'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const contract = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        text: z.string(),
        createdAt: z.number().default(0),
      }),
      key: 'id',
      references: { authorId: 'users' },
    },
  },
  roles: {
    user: { clientToServer: { noop: { input: z.void(), output: z.void() } } },
  },
})

type C = typeof contract

describe('contract collections — types', () => {
  it('names, row-out, and row-in infer from the schema', () => {
    type _Names = Expect<Equal<CollectionName<C>, 'users' | 'messages'>>
    type _UserRow = Expect<Equal<RowOf<C, 'users'>, { id: string; name: string }>>
    type _MsgRow = Expect<
      Equal<RowOf<C, 'messages'>, { id: string; channelId: string; authorId: string; text: string; createdAt: number }>
    >
    // `createdAt` has a default ⇒ optional on the INPUT side, required on the OUTPUT side.
    type _MsgIn = Expect<
      Equal<RowInputOf<C, 'messages'>, { id: string; channelId: string; authorId: string; text: string; createdAt?: number }>
    >
    expect(true).toBe(true)
  })

  it('a contract without collections yields an empty map and never names', () => {
    const bare = defineContract({ roles: { user: {} } })
    type _Empty = Expect<Equal<CollectionsOf<typeof bare>, {}>>
    type _NoNames = Expect<Equal<CollectionName<typeof bare>, never>>
    expect(true).toBe(true)
  })
})

describe('defineContract — collections runtime', () => {
  it('passes the collections block through unchanged (identity)', () => {
    expect(contract.collections?.messages?.key).toBe('id')
    expect(contract.collections?.messages?.references).toEqual({ authorId: 'users' })
    expect(Object.keys(contract.collections ?? {})).toEqual(['users', 'messages'])
  })
})

// ── the clustering discriminant, at the type level (ADR-0009) ────────────────────────────────────────────
// These are compile-time assertions: `pnpm typecheck` includes packages/*/test, so a @ts-expect-error that
// STOPS erroring fails the build. They exist because the enforcement they check is invisible at runtime —
// and because it is subtle enough that a plausible "cleanup" silently removes it (see below).
describe('CollectionStore is discriminated on clustering', () => {
  const ops: ResolvedRowOp[] = []
  const base = {
    snapshot: () => [],
    read: () => undefined,
    onChange: () => () => {},
  }

  it('rejects an async relay backend — this is the invariant that stops a cluster-wide echo storm', () => {
    const good: RelayCollectionStore = { ...base, clustering: 'relay', apply: () => [] }
    expect(good.clustering).toBe('relay')

    const bad: RelayCollectionStore = {
      ...base,
      clustering: 'relay',
      // @ts-expect-error a relay backend MUST apply synchronously: the relay ingress fires-and-forgets and
      // clears its re-publish guard in `finally`, so an async apply clears the guard before onChange fires.
      async apply() {
        return []
      },
    }
    expect(bad.clustering).toBe('relay')
  })

  // The reason RelayCollectionStore.apply returns RowChange[] rather than void, spelled out as a test:
  // TypeScript's void-return rule accepts a function returning ANYTHING where `void` is declared. So a
  // `void` apply would compile happily when async, and the invariant above would evaporate silently.
  it('would NOT reject an async backend if apply returned void — why the return type is load-bearing', () => {
    interface VoidApply {
      apply(ops: ResolvedRowOp[], origin: string): void
    }
    // no @ts-expect-error here: this compiles, and that is precisely the trap
    const sneaky: VoidApply = { async apply() {} }
    expect(sneaky.apply(ops, 'o')).toBeInstanceOf(Promise) // it really did return a promise
  })

  it('lets a self backend be async, and rejects one that returns rows', () => {
    const good: SelfCollectionStore = { ...base, clustering: 'self', apply: async () => {} }
    expect(good.clustering).toBe('self')

    const bad: SelfCollectionStore = {
      ...base,
      clustering: 'self',
      // @ts-expect-error a `self` backend's feed delivers the change on every node; returning rows from apply
      // implies it fires onChange too, which would double-deliver.
      apply: () => [],
    }
    expect(bad.clustering).toBe('self')
  })

  it('lets a read-only consumer use the union without narrowing', () => {
    // plugin-auth does exactly this: it only calls .read(), which is identical in both modes.
    const readOnly = (s: CollectionStore) => s.read('users', 'u1')
    expect(readOnly({ ...base, clustering: 'relay', apply: () => [] })).toBeUndefined()
    expect(readOnly({ ...base, clustering: 'self', apply: async () => {} })).toBeUndefined()
  })
})
