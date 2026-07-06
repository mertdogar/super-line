import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract, isCrdtCollection } from '@super-line/core'
import type { CollectionName, CrdtCollectionName, LwwCollectionName, DocOf, RowOf } from '@super-line/core'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
    scenes: {
      schema: z.object({ title: z.string(), nodes: z.array(z.string()) }),
      crdt: { mode: 'document', opaque: ['nodes'] },
    },
  },
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
})

type C = typeof contract

describe('CRDT collection contract types', () => {
  it('discriminates CRDT vs LWW collection names', () => {
    type _AllNames = Expect<Equal<CollectionName<C>, 'messages' | 'scenes'>>
    type _Crdt = Expect<Equal<CrdtCollectionName<C>, 'scenes'>>
    type _Lww = Expect<Equal<LwwCollectionName<C>, 'messages'>>
    expect(true).toBe(true)
  })

  it('types the CRDT doc from its schema (DocOf) end-to-end', () => {
    type Scene = DocOf<C, 'scenes'>
    type _Scene = Expect<Equal<Scene, { title: string; nodes: string[] }>>
    type _RowStillWorks = Expect<Equal<RowOf<C, 'messages'>, { id: string; text: string }>>
    expect(true).toBe(true)
  })

  it('isCrdtCollection is a runtime + type guard', () => {
    expect(isCrdtCollection(contract.collections.scenes)).toBe(true)
    expect(isCrdtCollection(contract.collections.messages)).toBe(false)
    const def = contract.collections.scenes
    if (isCrdtCollection(def)) expect(def.crdt.mode).toBe('document')
  })
})
