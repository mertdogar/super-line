import { useEffect, useState } from 'react'
import * as Y from 'yjs'

// The synced state: a board of shapes. Each shape is its own Y.Map so concurrent edits
// to different fields (one user drags, another recolors) merge per-field instead of
// clobbering the whole object.
export interface Shape {
  id: string
  x: number
  y: number
  color: string
  label: string
  order: number
}

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

// Shapes live in a keyed map `{ id -> shape }`, NOT a positional array. z-order is a
// per-shape `order` field, sorted at read time — so a "bring to front" is a single
// last-writer-wins write and concurrent reorders can't duplicate/lose a shape. See
// docs/adr/0001-automerge-over-yjs-for-synced-scene-state.md (the rule is CRDT-agnostic).
export function shapesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('shapes')
}

export function readShapes(doc: Y.Doc): Shape[] {
  const out: Shape[] = []
  shapesMap(doc).forEach((m, id) => {
    out.push({
      id,
      x: Number(m.get('x') ?? 0),
      y: Number(m.get('y') ?? 0),
      color: String(m.get('color') ?? '#888'),
      label: String(m.get('label') ?? ''),
      order: Number(m.get('order') ?? 0),
    })
  })
  return out.sort((a, b) => a.order - b.order)
}

// The plain-JSON snapshot of the synced state, for the debug panel. (Y.Doc.toJSON() is
// deprecated, so we project from the map directly.)
export function readState(doc: Y.Doc): unknown {
  return { shapes: shapesMap(doc).toJSON() }
}

function topOrder(doc: Y.Doc): number {
  let max = 0
  shapesMap(doc).forEach((m) => {
    max = Math.max(max, Number(m.get('order') ?? 0))
  })
  return max + 1
}

export function addShape(doc: Y.Doc): void {
  const id = `S_${Math.random().toString(36).slice(2, 8)}`
  const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#888'
  const m = new Y.Map<unknown>()
  // One transaction = one CRDT update, so the whole shape lands (and broadcasts) atomically.
  doc.transact(() => {
    m.set('x', Math.round(Math.random() * 340))
    m.set('y', Math.round(Math.random() * 320))
    m.set('color', color)
    m.set('label', id.slice(2))
    m.set('order', topOrder(doc))
    shapesMap(doc).set(id, m)
  }, 'local')
}

export function moveShape(doc: Y.Doc, id: string, x: number, y: number): void {
  const m = shapesMap(doc).get(id)
  if (!m) return
  doc.transact(() => {
    m.set('x', x)
    m.set('y', y)
  }, 'local')
}

export function bringToFront(doc: Y.Doc, id: string): void {
  const m = shapesMap(doc).get(id)
  if (!m) return
  doc.transact(() => m.set('order', topOrder(doc)), 'local')
}

export function deleteShape(doc: Y.Doc, id: string): void {
  doc.transact(() => shapesMap(doc).delete(id), 'local')
}

// Re-render the React tree whenever the document changes — local edit or merged remote
// update, they both fire `doc.on('update')`.
export function useShapes(doc: Y.Doc): Shape[] {
  const [shapes, setShapes] = useState<Shape[]>(() => readShapes(doc))
  useEffect(() => {
    const sync = (): void => setShapes(readShapes(doc))
    doc.on('update', sync)
    sync()
    return () => doc.off('update', sync)
  }, [doc])
  return shapes
}

// One decoded change inside a patch — the native Yjs `observeDeep` event shape.
export interface YPatch {
  path: (string | number)[]
  key: string
  action: string
  value?: unknown
}

export interface PatchEntry {
  id: number
  origin: string
  at: number
  changes: YPatch[]
}

export function formatChange(c: YPatch): string {
  const loc = [...c.path, c.key].join('/')
  return c.action === 'delete' ? `delete ${loc}` : `${c.action} ${loc} = ${JSON.stringify(c.value)}`
}

// A live, capped log of decoded changes. Yjs hands you a readable diff via `observeDeep`
// (NOT the opaque update bytes); the transaction origin tells you local vs peer vs server.
// The one-time catch-up apply is tagged `sync` and skipped so the log shows only live edits.
export function usePatchLog(doc: Y.Doc): PatchEntry[] {
  const [log, setLog] = useState<PatchEntry[]>([])
  useEffect(() => {
    let n = 0
    const map = shapesMap(doc)
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction): void => {
      const origin = typeof tx.origin === 'string' ? tx.origin : 'local'
      if (origin === 'sync') return
      const changes: YPatch[] = []
      for (const ev of events) {
        const target = ev.target as Y.Map<unknown>
        ev.changes.keys.forEach((change, key) => {
          changes.push({
            path: ev.path,
            key,
            action: change.action,
            value: change.action === 'delete' ? undefined : target.get(key),
          })
        })
      }
      if (changes.length === 0) return
      n += 1
      const entry: PatchEntry = { id: n, origin, at: Date.now(), changes }
      setLog((prev) => [entry, ...prev].slice(0, 50))
    }
    map.observeDeep(handler)
    return () => map.unobserveDeep(handler)
  }, [doc])
  return log
}
