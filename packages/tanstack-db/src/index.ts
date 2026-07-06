import { isCrdtCollection } from '@super-line/core'
import type { Contract, RoleOf, CollectionName, RowOf, CollectionQuery } from '@super-line/core'
import type { SuperLineClient, CollectionHandle } from '@super-line/client'
import type { CollectionConfig } from '@tanstack/db'

/** Options for {@link superLineCollectionOptions}. */
export interface SuperLineCollectionOptions {
  /** The subset to sync (filter / orderBy / limit). Omit for the whole collection, subject to the server's row policy. */
  query?: CollectionQuery
}

/**
 * Build TanStack DB collection options backed by a super-line collection. Feed the result to
 * `createCollection(...)`; TanStack then owns client-side live queries, joins, and optimistic mutations while
 * super-line is the server-authoritative sync source.
 *
 * - The initial snapshot + live changes flow from `client.collection(name).subscribe(query)`.
 * - Optimistic mutations map to atomic super-line batches (`onInsert`/`onUpdate`/`onDelete`); the ack resolves
 *   the optimistic transaction, an error rolls it back.
 * - `getKey` comes from the contract. No client-side schema validation is wired: super-line validates every
 *   write on the server (ADR-0006). // ponytail: pass the contract schema through here for optimistic pre-validation if wanted.
 *
 * @example
 * ```ts
 * const messages = createCollection(superLineCollectionOptions(client, contract, 'messages', { query: { filter: eq('channelId', id) } }))
 * const users = createCollection(superLineCollectionOptions(client, contract, 'users'))
 * const { data } = useLiveQuery((q) =>
 *   q.from({ m: messages }).join({ u: users }, ({ m, u }) => eq(u.id, m.authorId), 'inner'),
 * )
 * ```
 */
export function superLineCollectionOptions<C extends Contract, R extends RoleOf<C>, N extends CollectionName<C>>(
  client: SuperLineClient<C, R>,
  contract: C,
  name: N,
  opts: SuperLineCollectionOptions = {},
): CollectionConfig<RowOf<C, N> & object, string> {
  type Row = RowOf<C, N> & object
  const def = contract.collections?.[name]
  if (!def) throw new Error(`superLineCollectionOptions: collection '${String(name)}' is not declared on the contract`)
  if (isCrdtCollection(def)) throw new Error(`superLineCollectionOptions: collection '${String(name)}' is a CRDT document collection — TanStack DB serves LWW row collections only`)
  const key = def.key
  const handle = client.collection(name) as CollectionHandle<Row> // guarded LWW above; TanStack is the row surface

  return {
    id: `superline:${String(name)}`,
    getKey: (row) => (row as Record<string, unknown>)[key] as string,
    sync: {
      rowUpdateMode: 'full', // super-line updates carry the whole row
      sync: ({ begin, write, commit, markReady }) => {
        const rowSet = handle.subscribe(opts.query ?? {})
        let ready = false
        // A collection can be cleaned up before its initial snapshot resolves (e.g. an app that re-creates a
        // collection when its query changes). Once cleaned up, the sync-engine handles reject any call, so guard
        // every begin/write/commit/markReady behind this flag — set in the returned cleanup.
        let cancelled = false
        // Live changes after the initial snapshot. Pre-ready changes need no handling: they are already folded
        // into rowSet.rows(), which we write as the initial insert set at markReady time.
        const off = rowSet.subscribe((ev) => {
          if (!ready || cancelled) return
          begin()
          if (ev.type === 'delete') write({ type: 'delete', key: ev.id })
          else write({ type: ev.type, value: ev.row as Row })
          commit()
        })
        void rowSet.ready
          .then(() => {
            if (cancelled) return
            begin()
            for (const row of rowSet.rows()) write({ type: 'insert', value: row as Row })
            commit()
            ready = true
            markReady()
          })
          .catch(() => {
            // A denied subscribe (deny-by-default policy) still resolves the collection, empty — the rejection
            // surfaces through the client's own error channel, not by hanging the TanStack collection.
            if (!cancelled) markReady()
          })
        return () => {
          cancelled = true
          off()
          rowSet.close()
        }
      },
    },
    // Each optimistic transaction → ONE atomic super-line batch. Ack resolves the optimism; error rolls it back.
    onInsert: async ({ transaction }) => {
      await handle.batch(transaction.mutations.map((m) => ({ type: 'insert' as const, row: m.modified as Row })))
    },
    onUpdate: async ({ transaction }) => {
      await handle.batch(transaction.mutations.map((m) => ({ type: 'update' as const, row: m.modified as Row })))
    },
    onDelete: async ({ transaction }) => {
      await handle.batch(transaction.mutations.map((m) => ({ type: 'delete' as const, id: String(m.key) })))
    },
  }
}
