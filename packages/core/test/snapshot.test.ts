import { describe, expect, it } from 'vitest'
import { safeSnapshot } from '@super-line/core'

// The client tap drains through a channel that accepts JSON and nothing else, and throws on the
// whole batch rather than the offending row — so "always JSON-compliant" is the load-bearing
// property here, not a nicety. Every case below is a value that would otherwise break a drain.
const roundTrips = (v: unknown) => JSON.parse(JSON.stringify(safeSnapshot(v)))

describe('safeSnapshot', () => {
  it('passes primitives through unchanged', () => {
    expect(safeSnapshot('hi')).toBe('hi')
    expect(safeSnapshot(42)).toBe(42)
    expect(safeSnapshot(true)).toBe(true)
    expect(safeSnapshot(null)).toBe(null)
    expect(safeSnapshot(undefined)).toBe(undefined)
  })

  it('replaces values JSON cannot carry', () => {
    expect(safeSnapshot(10n)).toBe('10n')
    expect(safeSnapshot(() => {})).toBe('[Function]')
    expect(safeSnapshot(Symbol('s'))).toBe('Symbol(s)')
    expect(safeSnapshot(new Date('2026-07-28T00:00:00.000Z'))).toBe('2026-07-28T00:00:00.000Z')
  })

  it('survives a cycle instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(safeSnapshot(a)).toEqual({ name: 'a', self: '[Circular]' })
  })

  it('keeps sibling references that are not cycles', () => {
    const shared = { v: 1 }
    expect(safeSnapshot({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } })
  })

  it('collapses past the depth cap', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too far' } } } } } } }
    expect(safeSnapshot(deep)).toEqual({ a: { b: { c: { d: { e: { f: '[MaxDepth]' } } } } } })
  })

  it('truncates long arrays', () => {
    const out = safeSnapshot(Array.from({ length: 1500 }, (_, i) => i)) as unknown[]
    expect(out).toHaveLength(1000)
    expect(out[999]).toBe(999)
  })

  it('records a non-plain prototype rather than reconstructing it', () => {
    class Thing {
      constructor(public id: string) {}
    }
    expect(safeSnapshot(new Thing('t1'))).toEqual({ '#type': 'Thing', id: 't1' })
  })

  it('redacts named fields at every depth', () => {
    const redact = new Set(['token'])
    expect(safeSnapshot({ token: 'secret', nested: { token: 'also', ok: 1 } }, redact)).toEqual({
      token: '[Redacted]',
      nested: { token: '[Redacted]', ok: 1 },
    })
  })

  it('leaves fields alone when no redact set is given', () => {
    expect(safeSnapshot({ token: 'secret' })).toEqual({ token: 'secret' })
  })

  it('never mutates its input', () => {
    const input = { a: [1, 2], d: new Date(0) }
    const before = JSON.stringify(input)
    safeSnapshot(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('produces JSON-serializable output for every hostile shape', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() =>
      roundTrips({
        big: 1n,
        fn: () => {},
        sym: Symbol('x'),
        when: new Date(0),
        cyclic,
        map: new Map([['k', 'v']]),
        set: new Set([1]),
      }),
    ).not.toThrow()
  })
})
