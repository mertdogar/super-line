import { SuperLineError, applyQuery } from '@super-line/core'
import type { CollectionStore, ResolvedRowOp, RowChange, RowTimestamps } from '@super-line/core'

/** A stored row plus its creation / last-update wall-clock (epoch ms) — the timestamps are inspector-only. */
interface Entry {
  row: unknown
  createdAt: number
  updatedAt: number
}

/**
 * The in-memory CollectionStore — the zero-dependency default for typed row collections. Holds every
 * collection's rows in nested `Map`s and applies batches atomically via an undo log. `clustering: 'relay'`:
 * it does no networking; super-line core relays batches across nodes and re-ingests remote batches through
 * {@link CollectionStore.apply}, so every node is a converged LWW replica.
 */
export function memoryCollections(): CollectionStore {
  const data = new Map<string, Map<string, Entry>>() // collection name → (row id → entry)
  const listeners = new Set<(change: RowChange) => void>()
  const now = (): number => Date.now()

  const tableOf = (n: string): Map<string, Entry> => {
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
      const ts = now() // one clock read for the whole batch: it is atomic, so it happened at one instant
      try {
        for (const op of ops) {
          const t = tableOf(op.n)
          if (op.op === 'insert') {
            if (t.has(op.id)) throw new SuperLineError('CONFLICT', `Row already exists: ${op.n}/${op.id}`)
            t.set(op.id, { row: op.row, createdAt: ts, updatedAt: ts })
            undo.push(() => t.delete(op.id))
            changes.push({ n: op.n, k: 'insert', id: op.id, next: op.row, origin })
          } else if (op.op === 'update') {
            const prev = t.get(op.id)
            if (!prev) throw new SuperLineError('NOT_FOUND', `No row: ${op.n}/${op.id}`)
            t.set(op.id, { row: op.row, createdAt: prev.createdAt, updatedAt: ts }) // createdAt frozen; updatedAt bumps
            undo.push(() => t.set(op.id, prev))
            changes.push({ n: op.n, k: 'update', id: op.id, prev: prev.row, next: op.row, origin })
          } else {
            const prev = t.get(op.id)
            if (!prev) continue // idempotent delete
            t.delete(op.id)
            undo.push(() => t.set(op.id, prev))
            changes.push({ n: op.n, k: 'delete', id: op.id, prev: prev.row, origin })
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
      return t ? applyQuery([...t.values()].map((e) => e.row), query) : []
    },
    read(n, id) {
      return data.get(n)?.get(id)?.row
    },
    rowMeta(n, ids) {
      const t = data.get(n)
      const out: Record<string, RowTimestamps> = {}
      if (t) for (const id of ids) {
        const e = t.get(id)
        if (e) out[id] = { createdAt: e.createdAt, updatedAt: e.updatedAt }
      }
      return out
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
