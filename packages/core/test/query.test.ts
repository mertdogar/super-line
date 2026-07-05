import { describe, it, expect } from 'vitest'
import {
  and,
  or,
  not,
  eq,
  neq,
  lt,
  lte,
  gt,
  gte,
  isIn,
  like,
  ilike,
  andFilters,
  evalExpr,
  matchesFilter,
  applyQuery,
  getField,
} from '@super-line/core'
import type { Expr, CollectionQuery } from '@super-line/core'

const row = { id: 'm1', channelId: 'general', authorId: 'u1', text: 'Hello World', likes: 3, pinned: false, author: { name: 'Ada' }, tag: null }

describe('getField', () => {
  it('reads shallow and dot-path fields', () => {
    expect(getField(row, 'channelId')).toBe('general')
    expect(getField(row, 'author.name')).toBe('Ada')
  })
  it('returns undefined for missing paths and non-objects', () => {
    expect(getField(row, 'nope')).toBeUndefined()
    expect(getField(row, 'author.missing')).toBeUndefined()
    expect(getField(row, 'channelId.x')).toBeUndefined()
    expect(getField(null, 'a')).toBeUndefined()
  })
})

describe('evalExpr — leaves', () => {
  it('eq / neq', () => {
    expect(evalExpr(eq('channelId', 'general'), row)).toBe(true)
    expect(evalExpr(eq('channelId', 'random'), row)).toBe(false)
    expect(evalExpr(neq('channelId', 'random'), row)).toBe(true)
    expect(evalExpr(eq('pinned', false), row)).toBe(true)
    expect(evalExpr(eq('tag', null), row)).toBe(true)
  })
  it('missing field never equals a scalar (missing ≠ null)', () => {
    expect(evalExpr(eq('nope', null), row)).toBe(false)
    expect(evalExpr(neq('nope', 'x'), row)).toBe(true)
  })
  it('range ops on numbers and strings', () => {
    expect(evalExpr(gt('likes', 2), row)).toBe(true)
    expect(evalExpr(gte('likes', 3), row)).toBe(true)
    expect(evalExpr(lt('likes', 3), row)).toBe(false)
    expect(evalExpr(lte('likes', 3), row)).toBe(true)
    expect(evalExpr(gt('channelId', 'a'), row)).toBe(true)
  })
  it('range ops on incomparable / mismatched types are false', () => {
    expect(evalExpr(gt('likes', 'x' as unknown as number), row)).toBe(false)
    expect(evalExpr(lt('author', 5 as unknown as number), row)).toBe(false)
    expect(evalExpr(gt('nope', 1), row)).toBe(false)
  })
  it('in', () => {
    expect(evalExpr(isIn('channelId', ['general', 'random']), row)).toBe(true)
    expect(evalExpr(isIn('channelId', ['random']), row)).toBe(false)
    expect(evalExpr(isIn('channelId', []), row)).toBe(false)
  })
  it('like / ilike with % and _ wildcards', () => {
    expect(evalExpr(like('text', 'Hello%'), row)).toBe(true)
    expect(evalExpr(like('text', '%World'), row)).toBe(true)
    expect(evalExpr(like('text', 'hello%'), row)).toBe(false) // case-sensitive
    expect(evalExpr(ilike('text', 'hello%'), row)).toBe(true)
    expect(evalExpr(like('text', 'Hell_ World'), row)).toBe(true)
    expect(evalExpr(like('id', 'm1'), row)).toBe(true)
    expect(evalExpr(like('likes', '3'), row)).toBe(false) // non-string field
  })
  it('like escapes regex metacharacters in the pattern', () => {
    expect(evalExpr(like('text', 'Hello.World'), row)).toBe(false) // '.' is literal, not any-char
    expect(evalExpr(like('text', 'Hello World'), { ...row, text: 'Hello World' })).toBe(true)
  })
})

describe('evalExpr — composition', () => {
  it('and / or / not', () => {
    expect(evalExpr(and(eq('channelId', 'general'), gt('likes', 2)), row)).toBe(true)
    expect(evalExpr(and(eq('channelId', 'general'), gt('likes', 5)), row)).toBe(false)
    expect(evalExpr(or(eq('channelId', 'random'), eq('authorId', 'u1')), row)).toBe(true)
    expect(evalExpr(not(eq('channelId', 'random')), row)).toBe(true)
  })
  it('empty and ⇒ true, empty or ⇒ false', () => {
    expect(evalExpr(and(), row)).toBe(true)
    expect(evalExpr(or(), row)).toBe(false)
  })
  it('nested composition', () => {
    const expr = and(eq('authorId', 'u1'), or(eq('channelId', 'general'), gt('likes', 100)))
    expect(evalExpr(expr, row)).toBe(true)
  })
})

describe('andFilters / matchesFilter', () => {
  it('combines optional filters, dropping undefined', () => {
    expect(andFilters(undefined, undefined)).toBeUndefined()
    expect(andFilters(eq('a', 1), undefined)).toEqual(eq('a', 1))
    const both = andFilters(eq('channelId', 'general'), gt('likes', 2))
    expect(both).toEqual(and(eq('channelId', 'general'), gt('likes', 2)))
    expect(evalExpr(both as Expr, row)).toBe(true)
  })
  it('matchesFilter treats undefined as always-match', () => {
    expect(matchesFilter(undefined, row)).toBe(true)
    expect(matchesFilter(eq('channelId', 'general'), row)).toBe(true)
    expect(matchesFilter(eq('channelId', 'random'), row)).toBe(false)
  })
})

describe('applyQuery', () => {
  const rows = [
    { id: 'a', n: 3, name: 'c' },
    { id: 'b', n: 1, name: 'a' },
    { id: 'c', n: 2, name: 'b' },
    { id: 'd', n: 1, name: 'z' },
  ]
  it('filters', () => {
    expect(applyQuery(rows, { filter: gte('n', 2) }).map((r) => r.id)).toEqual(['a', 'c'])
  })
  it('sorts by a single key', () => {
    expect(applyQuery(rows, { orderBy: [{ field: 'n', dir: 'asc' }] }).map((r) => r.id)).toEqual(['b', 'd', 'c', 'a'])
    expect(applyQuery(rows, { orderBy: [{ field: 'n', dir: 'desc' }] }).map((r) => r.id)).toEqual(['a', 'c', 'b', 'd'])
  })
  it('sorts by multiple keys (tie-break)', () => {
    const q: CollectionQuery = { orderBy: [{ field: 'n', dir: 'asc' }, { field: 'name', dir: 'desc' }] }
    expect(applyQuery(rows, q).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a'])
  })
  it('applies offset and limit after sort', () => {
    const q: CollectionQuery = { orderBy: [{ field: 'n', dir: 'asc' }], limit: 2, offset: 1 }
    expect(applyQuery(rows, q).map((r) => r.id)).toEqual(['d', 'c'])
  })
  it('does not mutate the input array', () => {
    const copy = rows.slice()
    applyQuery(rows, { orderBy: [{ field: 'n', dir: 'asc' }] })
    expect(rows).toEqual(copy)
  })
  it('sorts null/undefined fields last', () => {
    const withNulls = [{ id: 'x', n: 2 }, { id: 'y' }, { id: 'z', n: 1 }]
    expect(applyQuery(withNulls, { orderBy: [{ field: 'n', dir: 'asc' }] }).map((r) => r.id)).toEqual(['z', 'x', 'y'])
  })
})
