import {
  isCrdtCollection,
  SuperLineError,
  type CollectionDef,
  type CollectionStore,
  type RelayCollectionStore,
  type ResolvedRowOp,
  type RowCondition,
  type SelfCollectionStore,
} from '@super-line/core'

/** The backends {@link composeCollections} routes between: a named collection goes to its own, the rest to `default`. */
export type ComposedCollections = { default: CollectionStore } & Record<string, CollectionStore>

// each composite's routed names, for the server's check against its contract
const routed = new WeakMap<CollectionStore, string[]>()

const namesOf = (conditions: RowCondition[], ops: ResolvedRowOp[]): string[] => [
  ...conditions.map((c) => c.n),
  ...ops.map((o) => o.n),
]

/**
 * Serve some collections from another backend: one {@link CollectionStore} over several, routed by collection
 * name. `snapshot`/`read`/`rowMeta`/`fixedFields` go to the collection's backend (else `default`), `onChange` fans
 * in from every backend, `close` closes them all. Atomicity is per backend, so a batch must stay inside one: a
 * batch spanning two throws `VALIDATION` before anything is applied.
 *
 * The composite is `self` only when every backend is — the server then never relays, which a node-local `relay`
 * backend needs to converge. Any mix is `relay`, and its `self` collections are read-only through it (`FORBIDDEN`):
 * a relay `apply` must be synchronous and return its changes, and the server re-applies every committed batch on
 * every node, so a write into a backend that propagates itself would land once per node. Snapshots, reads and
 * the backend's own feed need neither, so they route as usual.
 *
 * Give each backend only the collections it serves. One that lays out storage per collection opens a table for
 * every collection it is handed, so leave the routed ones out of `default`:
 *
 * ```ts
 * const { storeRows: _, ...owned } = contract.collections
 * composeCollections({ default: cloudflareCollections(ctx.storage, owned), storeRows: remoteRows({ ... }) })
 * ```
 *
 * The server refuses to start when a name other than `default` is not a row collection on its contract.
 */
export function composeCollections(backends: ComposedCollections): CollectionStore {
  const stores = [...new Set(Object.values(backends))]
  const track = (store: CollectionStore) => {
    routed.set(store, Object.keys(backends).filter((n) => n !== 'default'))
    return store
  }
  const route = (n: string): CollectionStore => (Object.hasOwn(backends, n) ? backends[n]! : backends.default)

  function ownerOf(names: string[]): CollectionStore {
    const owners = new Set(names.map(route))
    if (owners.size > 1)
      throw new SuperLineError('VALIDATION', `A batch spans collection backends: ${[...new Set(names)].join(', ')}`)
    const [owner = backends.default] = owners
    return owner
  }

  function relayOwnerOf(names: string[]): RelayCollectionStore {
    const owner = ownerOf(names)
    if (owner.clustering === 'self')
      throw new SuperLineError('FORBIDDEN', `Read-only here: ${[...new Set(names)].join(', ')} (a self backend in a relay composite)`)
    return owner
  }

  const reads: Pick<CollectionStore, 'snapshot' | 'read' | 'rowMeta' | 'fixedFields' | 'onChange' | 'close'> = {
    snapshot: (n, query) => route(n).snapshot(n, query),
    read: (n, id) => route(n).read(n, id),
    rowMeta: (n, ids) => route(n).rowMeta?.(n, ids) ?? {},
    fixedFields: (n) => route(n).fixedFields?.(n) ?? [],
    onChange(cb) {
      const offs = stores.map((s) => s.onChange(cb))
      return () => {
        for (const off of offs) off()
      }
    },
    async close() {
      await Promise.all(stores.map(async (s) => s.close?.()))
    },
  }

  if (stores.every((s) => s.clustering === 'self')) {
    const selfOwnerOf = (names: string[]) => ownerOf(names) as SelfCollectionStore
    return track({
      ...reads,
      clustering: 'self',
      coordination: 'cluster',
      apply: (ops, origin) => selfOwnerOf(namesOf([], ops)).apply(ops, origin),
      conditionalApply: (conditions, ops, origin) =>
        selfOwnerOf(namesOf(conditions, ops)).conditionalApply(conditions, ops, origin),
    })
  }

  return track({
    ...reads,
    clustering: 'relay',
    coordination: 'local',
    apply: (ops, origin) => relayOwnerOf(namesOf([], ops)).apply(ops, origin),
    conditionalApply: (conditions, ops, origin) =>
      relayOwnerOf(namesOf(conditions, ops)).conditionalApply(conditions, ops, origin),
  })
}

/** Throws when a {@link composeCollections} composite routes a name that is not a row collection in `defs`. */
export function checkComposedNames(store: CollectionStore | undefined, defs: Record<string, CollectionDef>): void {
  for (const n of (store && routed.get(store)) ?? []) {
    const def = defs[n]
    if (!def || isCrdtCollection(def))
      throw new Error(`composeCollections routes '${n}', which is not a row collection on the contract`)
  }
}
