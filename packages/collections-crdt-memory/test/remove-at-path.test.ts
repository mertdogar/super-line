import { describe, expect, it } from 'vitest'
import { StoreValue } from '@super-store/store'
import { removeAtPath } from '@super-line/core'

/**
 * `removeAtPath` (core/src/store.ts) is the surgical key-removal primitive behind every CRDT `delete(path)` —
 * the server co-writer's (`srv.collection(n).open(id).delete`, used by examples/ai-canvas's agent), the client
 * replica's (`crdtCollectionsClient`), and the pglite self-tier's. It had **no tests anywhere**, and it cannot
 * meaningfully have unit tests: its whole contract is a property of `removeAtPath` COMPOSED with
 * `StoreValue.set`'s diff-and-patch, under concurrent writers. So it is tested here, where that composition
 * lives, rather than in core where the function does.
 *
 * The contract (store.ts): *"Clones only along the path (not a deep clone): fed to a diff-and-patch `set`,
 * only the removed key is rewritten, so concurrent edits to sibling keys still merge."*
 *
 * The array branch looks like it must violate that — it `splice`s, which renumbers every later index, and a
 * naive positional diff would then rewrite them all and clobber a concurrent sibling edit. It does not: the
 * diff is structural, so a shorter array yields a minimal list delta. These tests exist because that
 * reasoning is genuinely counter-intuitive and was gotten wrong by reading the code instead of running it.
 */

const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

type Peer = { sv: StoreValue<Record<string, unknown>, 'document'>; out: string[] }

/** Two independent replicas seeded from one Yjs state — the real concurrency shape, not two sequential writes. */
function pair(initial: Record<string, unknown>): { a: Peer; b: Peer } {
  const seed = new StoreValue<Record<string, unknown>, 'document'>(initial, { mode: 'document' })
  const state = b64(seed.encodeState())
  const mk = (): Peer => {
    const sv = new StoreValue<Record<string, unknown>, 'document'>({}, { mode: 'document' })
    const out: string[] = []
    sv.onUpdate((u, meta) => {
      if (meta.local) out.push(b64(u))
    })
    sv.applyUpdate(fromB64(state))
    out.length = 0 // the seed itself isn't a local edit to exchange
    return { sv, out }
  }
  return { a: mk(), b: mk() }
}

/** Exchange both peers' pending deltas — concurrent edits, merged after the fact. */
function sync(x: Peer, y: Peer): void {
  const xs = [...x.out]
  const ys = [...y.out]
  for (const u of xs) y.sv.applyUpdate(fromB64(u))
  for (const u of ys) x.sv.applyUpdate(fromB64(u))
}

/** Exactly what every `delete(path)` call site does: removeAtPath the snapshot, then set the result. */
function deleteAt(p: Peer, path: (string | number)[]): void {
  p.sv.set(removeAtPath(p.sv.getSnapshot(), path) as Record<string, unknown>)
}

const converged = (a: Peer, b: Peer): unknown => {
  expect(a.sv.getSnapshot()).toEqual(b.sv.getSnapshot()) // convergence is the CRDT's whole promise
  return a.sv.getSnapshot()
}

describe('removeAtPath ∘ StoreValue.set — object branch (delete next[head])', () => {
  it('a concurrent edit to a sibling key survives the delete', () => {
    const { a, b } = pair({ items: { x: 'a', y: 'b', z: 'c' } })
    deleteAt(a, ['items', 'x'])
    b.sv.update({ items: { z: 'C!' } })
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: { y: 'b', z: 'C!' } })
  })

  it('removes a key nested inside an array element without disturbing its siblings', () => {
    const { a, b } = pair({ items: [{ id: 'x', tag: 't' }, { id: 'y', v: 2 }] })
    deleteAt(a, ['items', 0, 'tag'])
    b.sv.set({ items: [{ id: 'x', tag: 't' }, { id: 'y', v: 99 }] })
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: [{ id: 'x' }, { id: 'y', v: 99 }] })
  })
})

// The counter-intuitive half. splice() renumbers every later index, yet none of these clobber, because the
// diff feeding Yjs is structural rather than positional. Read the code and you will predict otherwise.
describe('removeAtPath ∘ StoreValue.set — array branch (splice)', () => {
  it('a concurrent edit to a LATER element survives, despite splice renumbering it', () => {
    const { a, b } = pair({ items: ['a', 'b', 'c'] })
    deleteAt(a, ['items', 0]) // → ['b','c']: every surviving element changes index
    b.sv.set({ items: ['a', 'b', 'C!'] }) // B edits index 2, concurrently
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: ['b', 'C!'] })
  })

  it('a concurrent edit to the element the delete SHIFTS survives', () => {
    const { a, b } = pair({ items: ['a', 'b', 'c'] })
    deleteAt(a, ['items', 0]) // 'b' moves from index 1 → 0
    b.sv.set({ items: ['a', 'B!', 'c'] }) // B edits that very element, at its OLD index
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: ['B!', 'c'] })
  })

  it('concurrent deletes of different elements both take effect', () => {
    const { a, b } = pair({ items: ['a', 'b', 'c'] })
    deleteAt(a, ['items', 0])
    deleteAt(b, ['items', 2])
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: ['b'] })
  })

  it('a concurrent append survives a delete', () => {
    const { a, b } = pair({ items: ['a', 'b', 'c'] })
    deleteAt(a, ['items', 0])
    b.sv.set({ items: ['a', 'b', 'c', 'd'] })
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: ['b', 'c', 'd'] })
  })

  it('a concurrent field edit on a sibling OBJECT element survives', () => {
    const { a, b } = pair({ items: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }, { id: 'z', v: 3 }] })
    deleteAt(a, ['items', 0])
    b.sv.set({ items: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }, { id: 'z', v: 99 }] })
    sync(a, b)
    expect(converged(a, b)).toEqual({ items: [{ id: 'y', v: 2 }, { id: 'z', v: 99 }] })
  })
})

describe('removeAtPath — the documented edge cases', () => {
  it('never mutates the root it is given', () => {
    const root = { items: { x: 1, y: 2 }, other: [1, 2] }
    const before = JSON.parse(JSON.stringify(root))
    removeAtPath(root, ['items', 'x'])
    removeAtPath(root, ['other', 0])
    expect(root).toEqual(before)
  })

  it('returns the root unchanged for an empty path or a non-object', () => {
    const root = { a: 1 }
    expect(removeAtPath(root, [])).toBe(root) // same reference: an explicit no-op
    expect(removeAtPath('scalar', ['a'])).toBe('scalar')
    expect(removeAtPath(null, ['a'])).toBeNull()
  })

  it('is a no-op for a path that does not exist', () => {
    expect(removeAtPath({ a: 1 }, ['nope'])).toEqual({ a: 1 })
    expect(removeAtPath({ a: 1 }, ['a', 'deeper'])).toEqual({ a: 1 }) // descends into a scalar → unchanged
  })

  it('returns the same KIND as the root — which is why the call sites cast to an object safely', () => {
    // Every caller passes doc.getSnapshot() (always an object) and casts the result to Record<string, unknown>.
    // That cast is sound because the array branch only ever runs on a nested value, never on the root.
    expect(Array.isArray(removeAtPath(['a', 'b'], [0]))).toBe(true)
    expect(Array.isArray(removeAtPath({ items: ['a', 'b'] }, ['items', 0]))).toBe(false)
  })
})
