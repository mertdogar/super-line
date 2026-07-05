import { SuperLineError, applyQuery } from '@super-line/core'
import type { CollectionStore, ResolvedRowOp, RowChange } from '@super-line/core'

/**
 * The in-memory CollectionStore — the zero-dependency default for typed row collections. Holds every
 * collection's rows in nested `Map`s and applies batches atomically via an undo log. `clustering: 'relay'`:
 * it does no networking; super-line core relays batches across nodes and re-ingests remote batches through
 * {@link CollectionStore.apply}, so every node is a converged LWW replica.
 */
export function memoryCollections(): CollectionStore {
  const data = new Map<string, Map<string, unknown>>() // collection name → (row id → row)
  const listeners = new Set<(change: RowChange) => void>()

  const tableOf = (n: string): Map<string, unknown> => {
    let t = data.get(n)
    if (!t) data.set(n, (t = new Map()))
    return t
  }

  return {
    clustering: 'relay',
    apply(ops: ResolvedRowOp[], origin: string): RowChange[] {
      // Two-phase: mutate while recording undo thunks; on any throw, unwind so the batch is all-or-nothing
      // (and intra-batch dependencies — insert then update the same id — apply against evolving state).
      const undo: Array<() => void> = []
      const changes: RowChange[] = []
      try {
        for (const op of ops) {
          const t = tableOf(op.n)
          if (op.op === 'insert') {
            if (t.has(op.id)) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
            t.set(op.id, op.row)
            undo.push(() => t.delete(op.id))
            changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
          } else if (op.op === 'update') {
            if (!t.has(op.id)) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
            const prev = t.get(op.id)
            t.set(op.id, op.row)
            undo.push(() => t.set(op.id, prev))
            changes.push({ n: op.n, k: 'update', id: op.id, prev, next: op.row, origin })
          } else {
            if (!t.has(op.id)) continue // idempotent delete
            const prev = t.get(op.id)
            t.delete(op.id)
            undo.push(() => t.set(op.id, prev))
            changes.push({ n: op.n, k: 'delete', id: op.id, prev, origin })
          }
        }
      } catch (err) {
        for (const fn of undo.reverse()) fn()
        throw err
      }
      // Fan out only after the whole batch committed, so subscribers never observe a partial batch.
      for (const c of changes) for (const cb of listeners) cb(c)
      return changes
    },
    snapshot(n, query) {
      const t = data.get(n)
      return t ? applyQuery([...t.values()], query) : []
    },
    read(n, id) {
      return data.get(n)?.get(id)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
