import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { planColumns, DEGENERATE_DATA_COLUMN } from '@super-line/core'
import type { LwwCollectionDef, Schema } from '@super-line/core'

const col = (name: string) => (plan: ReturnType<typeof planColumns>) =>
  plan.columns.find((c) => c.name === name)!

describe('planColumns — scalar mapping', () => {
  // examples/collections-shaped flat schema
  const messages: LwwCollectionDef = {
    schema: z.object({
      id: z.string(),
      channelId: z.string(),
      text: z.string(),
      createdAt: z.number(),
      pinned: z.boolean(),
    }),
    key: 'id',
  }

  it('maps string/number/boolean to text/real/integer-bool', () => {
    const plan = planColumns(messages)
    expect(plan.degenerate).toBe(false)
    expect(col('id')(plan)).toEqual({ name: 'id', kind: 'text', optional: false, nullable: false })
    expect(col('createdAt')(plan).kind).toBe('real')
    expect(col('pinned')(plan).kind).toBe('integer-bool')
  })

  it('maps enums and string literals to text, number literals to real', () => {
    const plan = planColumns({
      schema: z.object({
        id: z.string(),
        visibility: z.enum(['public', 'private']),
        type: z.literal('message'),
        version: z.literal(1),
      }),
      key: 'id',
    })
    expect(col('visibility')(plan).kind).toBe('text')
    expect(col('type')(plan).kind).toBe('text')
    expect(col('version')(plan).kind).toBe('real')
  })

  it('keeps schema declaration order in columns', () => {
    const plan = planColumns(messages)
    expect(plan.columns.map((c) => c.name)).toEqual(['id', 'channelId', 'text', 'createdAt', 'pinned'])
  })
})

describe('planColumns — the census shapes', () => {
  // plugin-auth userSchema
  const users: LwwCollectionDef = {
    schema: z.object({
      id: z.string(),
      displayName: z.string(),
      roles: z.array(z.string()),
      createdAt: z.number(),
      deletedAt: z.number().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    key: 'id',
  }

  it('sends arrays and records to json, tracking optional/nullable', () => {
    const plan = planColumns(users)
    expect(col('roles')(plan)).toEqual({ name: 'roles', kind: 'json', optional: false, nullable: false })
    expect(col('metadata')(plan)).toEqual({ name: 'metadata', kind: 'json', optional: true, nullable: false })
    expect(col('deletedAt')(plan)).toEqual({ name: 'deletedAt', kind: 'real', optional: true, nullable: true })
  })

  it('handles plugin-chat style factory schemas (host-parametrized content)', () => {
    const messageSchema = <S extends z.ZodTypeAny>(content: S) =>
      z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        content: content.optional(),
        createdAt: z.number(),
      })
    const plan = planColumns({ schema: messageSchema(z.object({ blocks: z.array(z.string()) })), key: 'id' })
    expect(col('content')(plan)).toEqual({ name: 'content', kind: 'json', optional: true, nullable: false })
  })
})

describe('planColumns — wrappers', () => {
  it('erases optionality under default/catch (validated output always carries the field)', () => {
    const plan = planColumns({
      schema: z.object({
        id: z.string(),
        count: z.number().default(0),
        state: z.string().optional().default('idle'),
        safe: z.number().catch(0),
      }),
      key: 'id',
    })
    expect(col('count')(plan)).toEqual({ name: 'count', kind: 'real', optional: false, nullable: false })
    expect(col('state')(plan).optional).toBe(false)
    expect(col('safe')(plan).optional).toBe(false)
  })

  it('keeps outer optionality above a default, and nullability through a default', () => {
    const plan = planColumns({
      schema: z.object({
        id: z.string(),
        later: z.string().default('x').optional(),
        maybe: z.number().nullable().default(0),
      }),
      key: 'id',
    })
    expect(col('later')(plan).optional).toBe(true)
    expect(col('maybe')(plan)).toEqual({ name: 'maybe', kind: 'real', optional: false, nullable: true })
  })

  it('sees through refine but not transform', () => {
    const plan = planColumns({
      schema: z.object({
        id: z.string(),
        email: z.string().email().refine((v) => v.includes('@')),
        slug: z.string().transform((v) => v.toLowerCase()),
      }),
      key: 'id',
    })
    expect(col('email')(plan).kind).toBe('text')
    expect(col('slug')(plan).kind).toBe('json')
  })
})

describe('planColumns — degenerate (non-Zod) schemas', () => {
  const standardOnly = {
    '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
  } as unknown as Schema

  it('degrades to key + _sl_data json column', () => {
    const plan = planColumns({ schema: standardOnly, key: 'id' })
    expect(plan.degenerate).toBe(true)
    expect(plan.columns).toEqual([
      { name: 'id', kind: 'text', optional: false, nullable: false },
      { name: DEGENERATE_DATA_COLUMN, kind: 'json', optional: false, nullable: false },
    ])
    expect(plan.fingerprint).toContain('degenerate')
  })
})

describe('planColumns — fingerprint', () => {
  it('is insensitive to field declaration order', () => {
    const a = planColumns({ schema: z.object({ id: z.string(), n: z.number() }), key: 'id' })
    const b = planColumns({ schema: z.object({ n: z.number(), id: z.string() }), key: 'id' })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('changes when a type, flag, or key changes', () => {
    const base = planColumns({ schema: z.object({ id: z.string(), n: z.number() }), key: 'id' })
    const typed = planColumns({ schema: z.object({ id: z.string(), n: z.string() }), key: 'id' })
    const opt = planColumns({ schema: z.object({ id: z.string(), n: z.number().optional() }), key: 'id' })
    const keyed = planColumns({ schema: z.object({ id: z.string(), n: z.number(), k: z.string() }), key: 'k' })
    expect(new Set([base.fingerprint, typed.fingerprint, opt.fingerprint, keyed.fingerprint]).size).toBe(4)
  })
})

describe('planColumns — rejections', () => {
  it('rejects a key that is missing, non-string, or optional/nullable', () => {
    expect(() => planColumns({ schema: z.object({ id: z.string() }), key: 'nope' })).toThrow(/not a field/)
    expect(() => planColumns({ schema: z.object({ id: z.number() }), key: 'id' })).toThrow(/string field/)
    expect(() => planColumns({ schema: z.object({ id: z.string().optional() }), key: 'id' })).toThrow(
      /required and non-nullable/,
    )
    expect(() => planColumns({ schema: z.object({ id: z.string().nullable() }), key: 'id' })).toThrow(
      /required and non-nullable/,
    )
  })

  it('rejects reserved and non-identifier field names', () => {
    expect(() => planColumns({ schema: z.object({ id: z.string(), _sl_x: z.string() }), key: 'id' })).toThrow(
      /reserved '_sl_' prefix/,
    )
    expect(() => planColumns({ schema: z.object({ id: z.string(), 'foo-bar': z.string() }), key: 'id' })).toThrow(
      /not usable as a column name/,
    )
    expect(() =>
      planColumns({ schema: z.object({ id: z.string(), ['x'.repeat(61)]: z.string() }), key: 'id' }),
    ).toThrow(/not usable as a column name/)
  })

  it('rejects CRDT defs', () => {
    const crdtDef = { schema: z.object({}), crdt: { mode: 'shallow' } } as unknown as LwwCollectionDef
    expect(() => planColumns(crdtDef)).toThrow(/CRDT/)
  })
})
