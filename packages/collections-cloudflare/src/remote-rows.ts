import { SuperLineError, applyQuery } from '@super-line/core'
import type { Expr, RowChange, Scalar, SelfCollectionStore } from '@super-line/core'
import type { RemoteChange, RemoteChanges, RemotePush, RemoteRow } from './synced-sql.js'

type Awaitable<T> = T | Promise<T>

/** A source as the node reaches it: `syncedSql`'s reads, over RPC. A Durable Object stub satisfies it. */
export interface RemoteSource {
  snapshot(table: string | undefined, limit: number): Awaitable<RemoteRow[]>
  get(table: string, id: string): Awaitable<RemoteRow | undefined>
  changesSince(clock: number): Awaitable<RemoteChanges>
}

/** Where the node keeps the last clock it applied per source. `ctx.storage` satisfies it. */
export interface RemoteRowsStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

export interface RemoteRowsOptions {
  /** The contract collection, declared with `remoteRowsCollection(collection)`. */
  collection: string
  storage: RemoteRowsStorage
  stub(storeId: string): RemoteSource
  /**
   * The source's history broke (a dropped, renamed or altered table, pruned deletes, a reset source), so rows its
   * subscribers hold may be stale. Close their connections (`conn.raw.close(4409, 'resync')`): the client reconnects
   * and resubscribes into a fresh snapshot. Default: nothing.
   */
  onWipe?(storeId: string): unknown
  /** Rows a snapshot reads from the source table, at most. Default 1000. */
  snapshotLimit?: number
}

export interface RemoteRowsStore extends SelfCollectionStore {
  /** The forwarder's target: a source's `onChange` push. Applies it inline when it is the next clock, else pulls. */
  ingest(storeId: string, push: RemotePush): Promise<void>
  /**
   * Pull what these sources changed since their last clock — on wake, for the sources with surviving subscribers.
   * With no ids, every source the node keeps a clock for.
   */
  resume(storeIds?: string[]): Promise<void>
}

type Seen = { epoch: string; clock: number }

// `changesSince` from a future clock answers `wipeAll` with the current one: how a first subscribe learns it.
const CURRENT = Number.MAX_SAFE_INTEGER

const conjuncts = (expr: Expr | undefined): Expr[] =>
  expr === undefined ? [] : expr.op === 'and' ? expr.args.flatMap(conjuncts) : [expr]

const pinOf = (parts: Expr[], field: string): Scalar | undefined => {
  for (const e of parts) if (e.op === 'eq' && e.field === field) return e.value
  return undefined
}

// Both are part of the key, so a filter that rules them out never matched any version of the row.
const FIXED = ['storeId', 'table']

const isPin = (e: Expr) => e.op === 'eq' && (e.field === 'storeId' || e.field === 'table')

// The key splits at its first two colons, so a store id and a table name hold none.
const splitKey = (key: string): [string, string, string] | undefined => {
  const a = key.indexOf(':')
  const b = key.indexOf(':', a + 1)
  return a < 0 || b < 0 ? undefined : [key.slice(0, a), key.slice(a + 1, b), key.slice(b + 1)]
}

/**
 * The node side of a foreign Durable Object's SQLite: a read-only `self` {@link SelfCollectionStore} serving the rows
 * of every source the node fronts as one collection. The source pushes each committed batch to {@link
 * RemoteRowsStore.ingest} (`syncedSql`'s `onChange`); the node keeps the last clock per source in `storage` and pulls
 * `changesSince` when a push skips a clock, carries no changes or comes from a new epoch. A store's feed starts at
 * its first subscribe, and every subscribe pulls first.
 *
 * A snapshot must pin `storeId` by equality (`VALIDATION` otherwise) and may pin `table`; without it the read spans
 * every table of the store. The rest of the query runs on the rows read. Changes carry no prior row, so the server sends a data-less delete to a subscriber the new row doesn't
 * match — unless its filter rules out the row's `storeId` or `table`, which never change for a key. Writes throw
 * `FORBIDDEN`: they go through the source's own path.
 *
 * ```ts
 * const rows = remoteRows({ collection: 'storeRows', storage: ctx.storage, stub: (id) => env.STORE.getByName(id) })
 * createSuperLineServer(contract, { ...base, collections: composeCollections({ default, storeRows: rows }) })
 * ```
 */
export function remoteRows(opts: RemoteRowsOptions): RemoteRowsStore {
  const { collection, storage, stub, onWipe, snapshotLimit = 1000 } = opts
  const listeners = new Set<(change: RowChange) => void>()
  const queues = new Map<string, Promise<unknown>>()
  const prefix = `remote-rows:${collection}:`
  const stateKey = (storeId: string) => prefix + storeId

  const keyOf = (storeId: string, table: string, id: string) => `${storeId}:${table}:${id}`
  const rowOf = (storeId: string, { table, id, data }: RemoteRow) => ({ key: keyOf(storeId, table, id), storeId, table, id, data })

  // A put has no prior row the node could know, so it is an update without `prev` (the server routes it as such).
  const changeOf = (storeId: string, c: RemoteChange): RowChange => {
    const id = keyOf(storeId, c.table, c.id)
    if (c.op === 'delete') return { n: collection, k: 'delete', id, origin: storeId }
    return { n: collection, k: 'update', id, next: rowOf(storeId, c), origin: storeId }
  }

  const emit = (storeId: string, changes: RemoteChange[]) => {
    for (const c of changes) {
      const change = changeOf(storeId, c)
      for (const cb of listeners) cb(change)
    }
  }

  // One step at a time per source: a pull overtaken by a later one would land older rows last.
  const serial = <T>(storeId: string, step: () => Promise<T>): Promise<T> => {
    const run = (queues.get(storeId) ?? Promise.resolve()).then(step)
    queues.set(storeId, run.catch(() => {}))
    return run
  }

  const save = (storeId: string, { epoch, clock }: Seen) => storage.put<Seen>(stateKey(storeId), { epoch, clock })

  async function pull(storeId: string, seen: Seen | undefined): Promise<void> {
    const pulled = await stub(storeId).changesSince(seen?.clock ?? CURRENT)
    await save(storeId, pulled)
    if (!seen) return
    if (pulled.wipeAll || pulled.epoch !== seen.epoch) await onWipe?.(storeId)
    else emit(storeId, pulled.changes)
  }

  async function receive(storeId: string, push: RemotePush): Promise<void> {
    const seen = await storage.get<Seen>(stateKey(storeId))
    if (!seen) return
    const sameEpoch = push.epoch === seen.epoch
    if (sameEpoch && push.clock <= seen.clock) return
    if (!sameEpoch || push.clock !== seen.clock + 1 || !push.changes) return pull(storeId, seen)
    await save(storeId, push)
    emit(storeId, push.changes)
  }

  const catchUp = (storeId: string) => serial(storeId, async () => pull(storeId, await storage.get<Seen>(stateKey(storeId))))

  const readOnly = (): never => {
    throw new SuperLineError('FORBIDDEN', `Collection ${collection} is read-only: write through its source`)
  }

  return {
    clustering: 'self',
    coordination: 'cluster',
    ingest: (storeId, push) => serial(storeId, () => receive(storeId, push)),
    async resume(storeIds) {
      const ids = storeIds ?? [...(await storage.list({ prefix })).keys()].map((key) => key.slice(prefix.length))
      await Promise.all(ids.map(catchUp))
    },
    async snapshot(_n, query) {
      const parts = conjuncts(query.filter)
      const storeId = pinOf(parts, 'storeId')
      const table = pinOf(parts, 'table')
      if (typeof storeId !== 'string' || (table !== undefined && typeof table !== 'string'))
        throw new SuperLineError('VALIDATION', `A ${collection} subscription must pin storeId with eq()`)
      await catchUp(storeId)
      // only a query the pins alone decide can stop reading at its own window
      const exact = !query.orderBy?.length && parts.every(isPin) && query.limit !== undefined
      const limit = exact ? Math.min(snapshotLimit, (query.offset ?? 0) + (query.limit ?? 0)) : snapshotLimit
      const rows = await stub(storeId).snapshot(table, limit)
      return applyQuery(rows.map((row) => rowOf(storeId, row)), query)
    },
    async read(_n, key) {
      const parts = splitKey(key)
      if (!parts) return undefined
      const [storeId, table, id] = parts
      const row = await stub(storeId).get(table, id)
      return row && rowOf(storeId, row)
    },
    fixedFields: () => FIXED,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    apply: readOnly,
    conditionalApply: readOnly,
  }
}
