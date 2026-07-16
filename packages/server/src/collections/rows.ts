import {
  andFilters,
  isCrdtCollection,
  matchesFilter,
  orFilters,
  SuperLineError,
  validate,
  type CBatchFrame,
  type CChangeFrame,
  type CollectionQuery,
  type CSubFrame,
  type CUnsubFrame,
  type Expr,
  type ResolvedRowOp,
  type RowChange,
} from '@super-line/core'
import type {
  CollectionConn,
  CollectionHost,
  CollectionRuntimeConfig,
  CollectionPolicy,
  ServerCollectionHandle,
  WriteOp,
} from './types.js'

/** Fixed cluster channel carrying relayed row batches (compared by `===`, not a prefix). */
export const COLL_CHANNEL = 'cbatch'
/** Origin stamped on server co-writes, distinct from any client writer id. */
export const SERVER_ORIGIN = 'server'

/** The envelope a relayed batch travels in. `nd` is stamped by the Cluster, not by this module. */
export interface CollRelay {
  ops: ResolvedRowOp[]
  origin: string
}

type ConnCollState = {
  subs: Map<string, Map<number, CollectionQuery>>
  policy: Map<string, Expr | undefined>
}

export interface RowCollections {
  onSub(conn: CollectionConn, frame: CSubFrame): Promise<void>
  onUnsub(conn: CollectionConn, frame: CUnsubFrame): void
  onBatch(conn: CollectionConn, frame: CBatchFrame): Promise<void>
  onRelay(payload: string | Uint8Array): void
  detach(conn: CollectionConn): void
  handle(name: string): ServerCollectionHandle
  /** True when this node must subscribe to {@link COLL_CHANNEL} (a relay backend fans batches over the Adapter). */
  readonly isRelay: boolean
}

/**
 * Typed rows (ADR-0006). Routing is FILTER-based: each row change is evaluated against every subscribed
 * connection's effective visibility (policy read-filter ∧ the OR of its subscription filters), so the server
 * keeps only predicates per connection — never per-row membership. The CLIENT re-filters per subscription.
 * Writes are atomic batches; under relay the whole batch fans as ONE adapter message and re-applies on each
 * node, which then routes to its own local subscribers.
 *
 * Local delivery is **at the source**: `store.apply` fires `onChange` on the writing node, which routes
 * immediately — so the looped-back copy is dropped (`msg.own`). This is the opposite of the CRDT family, which
 * delivers on receipt. Neither is wrong; see the {@link Cluster} docs.
 */
export function createRowCollections(config: CollectionRuntimeConfig, host: CollectionHost): RowCollections {
  const { store, defs, policies, checkReferences } = config
  const isRelay = store?.clustering === 'relay'

  // collection name → conns with ≥1 live subscription (the routing index)
  const subscribers = new Map<string, Set<CollectionConn>>()
  // per-conn: subscription filters + cached policy read-filter
  const connState = new Map<CollectionConn, ConnCollState>()

  const policyOf = (n: string): CollectionPolicy<unknown, unknown> | undefined =>
    policies[n] as CollectionPolicy<unknown, unknown> | undefined

  const stateOf = (conn: CollectionConn): ConnCollState => {
    let s = connState.get(conn)
    if (!s) connState.set(conn, (s = { subs: new Map(), policy: new Map() }))
    return s
  }

  const principalOf = (conn: CollectionConn): string => conn.principal ?? conn.id

  function detach(conn: CollectionConn): void {
    connState.delete(conn)
    for (const set of subscribers.values()) set.delete(conn)
  }

  async function onSub(conn: CollectionConn, frame: CSubFrame): Promise<void> {
    if (!store || !defs[frame.n]) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: `Unknown collection: ${frame.n}` })
      return
    }
    await host.dispatch(
      conn,
      frame.i,
      { kind: 'subscribe', name: `collection:${frame.n}`, conn },
      async () => {
        const policy = policyOf(frame.n)
        if (!policy?.read) throw new SuperLineError('FORBIDDEN', `Read denied: ${frame.n}`) // deny-by-default
        const policyFilter = await policy.read(principalOf(conn), conn.ctx)
        const eff = andFilters(policyFilter, frame.q.filter)
        // Register BEFORE the snapshot read: a write committing while the snapshot query runs must
        // fan out as a live `cchg` — registering after the read put such a write in NEITHER the
        // snapshot NOR the feed (a permanently lost row; the auto-join-on-connect race). The client
        // buffers pre-snapshot changes and replays them after seeding, so cchg-before-res is safe.
        const state = stateOf(conn)
        let subs = state.subs.get(frame.n)
        if (!subs) state.subs.set(frame.n, (subs = new Map()))
        subs.set(frame.s, frame.q)
        state.policy.set(frame.n, policyFilter) // principal-derived; refreshed each (re)subscribe (staleness caveat)
        let set = subscribers.get(frame.n)
        if (!set) subscribers.set(frame.n, (set = new Set()))
        set.add(conn)
        let rows: unknown[]
        try {
          rows = await store.snapshot(frame.n, { ...frame.q, filter: eff })
        } catch (e) {
          subs.delete(frame.s) // failed subscribe must not leave a live registration behind
          if (subs.size === 0) {
            state.subs.delete(frame.n)
            set.delete(conn)
          }
          throw e
        }
        host.tap(() => ({
          type: 'collection.sub',
          connId: conn.id,
          role: conn.role,
          n: frame.n,
          sid: frame.s,
          query: frame.q,
          ok: true,
          count: rows.length,
        }))
        conn.send({ t: 'res', i: frame.i, d: rows }) // initial snapshot
      },
      (error) =>
        host.tap(() => ({
          type: 'collection.sub',
          connId: conn.id,
          role: conn.role,
          n: frame.n,
          sid: frame.s,
          query: frame.q,
          ok: false,
          error,
        })),
    )
  }

  function onUnsub(conn: CollectionConn, frame: CUnsubFrame): void {
    const state = connState.get(conn)
    const subs = state?.subs.get(frame.n)
    if (!state || !subs) return
    subs.delete(frame.s)
    host.tap(() => ({ type: 'collection.unsub', connId: conn.id, n: frame.n, sid: frame.s }))
    if (subs.size === 0) {
      state.subs.delete(frame.n)
      state.policy.delete(frame.n)
      subscribers.get(frame.n)?.delete(conn)
    }
  }

  // Validate + policy-guard every op against the current state. Throws to abort the whole batch (nothing applied).
  async function resolveOps(ops: CBatchFrame['ops'], principal: string, ctx: unknown): Promise<ResolvedRowOp[]> {
    if (!store) throw new SuperLineError('NOT_FOUND', 'No collection backend configured')
    const out: ResolvedRowOp[] = []
    for (const op of ops) {
      const def = defs[op.n]
      if (!def) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${op.n}`)
      if (isCrdtCollection(def))
        throw new SuperLineError(
          'NOT_FOUND',
          `Collection ${op.n} is a CRDT document collection — use collection(n).open(id), not a row batch`,
        )
      const policy = policyOf(op.n)
      if (!policy?.write) throw new SuperLineError('FORBIDDEN', `Write denied: ${op.n}`) // deny-by-default
      const prev = await store.read(op.n, op.id)
      if (op.op === 'delete') {
        if (!(await policy.write(principal, 'delete', undefined, prev, ctx)))
          throw new SuperLineError('FORBIDDEN', `Write denied: ${op.n}/${op.id}`)
        out.push({ op: 'delete', n: op.n, id: op.id })
        continue
      }
      const row = await validate(def.schema, op.d)
      const key = (row as Record<string, unknown>)[def.key]
      if (typeof key !== 'string')
        throw new SuperLineError('VALIDATION', `Collection ${op.n} row is missing string key '${def.key}'`)
      if (key !== op.id) throw new SuperLineError('VALIDATION', `Row key '${key}' does not match op id '${op.id}'`)
      if (checkReferences && def.references) {
        for (const [field, refCollection] of Object.entries(def.references)) {
          const ref = (row as Record<string, unknown>)[field]
          if (ref === undefined || ref === null) continue // an absent/null FK is "no reference"
          if ((await store.read(refCollection, String(ref))) === undefined)
            throw new SuperLineError(
              'VALIDATION',
              `Dangling reference: ${op.n}.${field} → ${refCollection}/${String(ref)} does not exist`,
            )
        }
      }
      const kind: WriteOp = op.op
      if (!(await policy.write(principal, kind, row, prev, ctx)))
        throw new SuperLineError('FORBIDDEN', `Write denied: ${op.n}/${op.id}`)
      out.push({ op: kind, n: op.n, id: op.id, row })
    }
    return out
  }

  // Apply a resolved batch atomically, fan out locally (via onChange → route), and — under relay — publish the
  // whole batch to other nodes. Shared by client batches and server co-writes.
  // ponytail: the guard reads `prev` in resolveOps then applies here; the backend's synchronous apply is the
  // real serialization point, so a TOCTOU only affects guards that read prev, and durable backends will wrap
  // resolve+apply in one transaction later.
  async function commit(ops: ResolvedRowOp[], origin: string, relay: boolean): Promise<void> {
    if (ops.length === 0 || !store) return
    await store.apply(ops, origin)
    if (relay && isRelay) host.cluster.broadcast(COLL_CHANNEL, { ops, origin } satisfies CollRelay)
  }

  async function onBatch(conn: CollectionConn, frame: CBatchFrame): Promise<void> {
    if (!store) {
      conn.send({ t: 'err', i: frame.i, code: 'NOT_FOUND', m: 'No collection backend configured' })
      return
    }
    await host.dispatch(
      conn,
      frame.i,
      { kind: 'request', name: 'collection:batch', conn },
      async () => {
        const principal = principalOf(conn)
        const resolved = await resolveOps(frame.ops, principal, conn.ctx)
        await commit(resolved, principal, true)
        host.tap(() => ({ type: 'collection.write', connId: conn.id, role: conn.role, ops: frame.ops, ok: true }))
        conn.send({ t: 'res', i: frame.i, d: null })
      },
      (error) =>
        host.tap(() => ({ type: 'collection.write', connId: conn.id, role: conn.role, ops: frame.ops, ok: false, error })),
    )
  }

  // The single fan-out source: route one applied row change to local subscribers whose effective filter admits
  // it (pre-op OR post-op — so a row that leaves a filter on update is delivered too, and the client removes it).
  function route(change: RowChange): void {
    host.tap(() => ({
      type: 'collection.change',
      n: change.n,
      op: change.k,
      id: change.id,
      origin: change.origin,
      row: change.next,
    }))
    const targets = subscribers.get(change.n)
    if (!targets || targets.size === 0) return
    for (const conn of targets) {
      const state = connState.get(conn)
      const subs = state?.subs.get(change.n)
      if (!state || !subs || subs.size === 0) continue
      const eff = andFilters(state.policy.get(change.n), orFilters([...subs.values()].map((q) => q.filter)))
      // A `self` backend surfaces a delete via its feed WITHOUT the prior row; deliver it to every subscriber and
      // let the client remove-if-present (it never held policy-hidden rows). Relay deletes always carry `prev`.
      const prevlessDelete = change.k === 'delete' && change.prev === undefined
      const inPrev = prevlessDelete || (change.prev !== undefined && matchesFilter(eff, change.prev))
      const inNext = change.next !== undefined && matchesFilter(eff, change.next)
      if (!inPrev && !inNext) continue
      conn.send({ t: 'cchg', n: change.n, k: change.k, id: change.id, d: change.next } satisfies CChangeFrame)
    }
  }

  function onRelay(payload: string | Uint8Array): void {
    const msg = host.cluster.receive(payload)
    if (!msg) return
    if (msg.own) return // deliver-at-source: our own publish looped back; already applied + routed locally
    if (!store || !isRelay) return
    const env = msg.data as CollRelay
    try {
      // relay backends apply synchronously (see CollectionStore.apply) — an async one would escape this catch
      void store.apply(env.ops, env.origin) // → onChange → route (this node's local conns)
    } catch {
      // insert-conflict / not-found from a cross-node race — drop; it converges on the next write.
      // ponytail: LWW-merge-on-conflict for concurrent same-id inserts is a phase-2 multi-node hardening.
    }
  }

  // Server co-writes: schema-validated, policy-free (server-authoritative), fan out + relay like a client batch.
  function handle(name: string): ServerCollectionHandle {
    if (!store) throw new SuperLineError('NOT_FOUND', 'No collection backend configured')
    const def = defs[name]
    // the runtime dispatches by family before calling here, so this only narrows the union for the compiler
    if (!def || isCrdtCollection(def)) throw new SuperLineError('NOT_FOUND', `Collection not declared: ${name}`)
    const resolve = async (row: unknown): Promise<{ id: string; row: unknown }> => {
      const v = await validate(def.schema, row)
      const key = (v as Record<string, unknown>)[def.key]
      if (typeof key !== 'string')
        throw new SuperLineError('VALIDATION', `Collection ${name} row is missing string key '${def.key}'`)
      return { id: key, row: v }
    }
    return {
      async insert(row) {
        const { id, row: v } = await resolve(row)
        await commit([{ op: 'insert', n: name, id, row: v }], SERVER_ORIGIN, true)
      },
      async update(row) {
        const { id, row: v } = await resolve(row)
        await commit([{ op: 'update', n: name, id, row: v }], SERVER_ORIGIN, true)
      },
      async delete(id) {
        await commit([{ op: 'delete', n: name, id }], SERVER_ORIGIN, true)
      },
      read(id) {
        return Promise.resolve(store.read(name, id))
      },
      snapshot(query) {
        return Promise.resolve(store.snapshot(name, query ?? {}))
      },
      ...(store.rowMeta ? { rowMeta: (ids: string[]) => Promise.resolve(store.rowMeta!(name, ids)) } : {}),
    }
  }

  if (store) store.onChange(route) // one subscription drives all local delivery

  return { onSub, onUnsub, onBatch, onRelay, detach, handle, isRelay }
}
