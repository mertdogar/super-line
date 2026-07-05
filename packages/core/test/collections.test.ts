import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { CollectionName, RowOf, RowInputOf, CollectionsOf } from '@super-line/core'

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
