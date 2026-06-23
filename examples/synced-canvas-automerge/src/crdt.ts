import * as A from '@automerge/automerge'
import { toB64 } from './b64.js'

export interface Shape {
  id: string
  x: number
  y: number
  color: string
  label: string
  order: number
}

// A `type` (not `interface`) so it satisfies Automerge's `from<T extends Record<string, unknown>>`.
export type Canvas = {
  shapes: Record<string, Shape>
}

export type Doc = A.Doc<Canvas>

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

export function readShapes(doc: Doc): Shape[] {
  // `?? {}` guards the brief pre-load window: a fresh `A.init()` doc has no `shapes` yet.
  const shapes = doc.shapes ?? {}
  return Object.values(shapes).sort((a, b) => a.order - b.order)
}

function topOrder(shapes: Record<string, Shape>): number {
  let max = 0
  for (const s of Object.values(shapes)) max = Math.max(max, s.order)
  return max + 1
}

// Each edit returns the NEW doc (Automerge docs are immutable) plus the base64-encoded
// change(s) it produced, ready to push over the bus. Compare the Yjs example, where an
// in-place mutation + a `doc.on('update')` observer produced the bytes for you — here the
// caller must thread the returned doc and changes around explicitly.
function edit(doc: Doc, fn: (c: Canvas) => void): [Doc, string[], A.Patch[]] {
  // Automerge hands you a decoded, path-addressed diff via `patchCallback` — the native
  // patch shape ({ action, path, value }), NOT the opaque change bytes on the wire.
  let patches: A.Patch[] = []
  const next = A.change(doc, { patchCallback: (p: A.Patch[]) => (patches = p) }, fn)
  return [next, A.getChanges(doc, next).map(toB64), patches]
}

export function addShape(doc: Doc): [Doc, string[], A.Patch[]] {
  const id = `S_${Math.random().toString(36).slice(2, 8)}`
  const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#888'
  // z-order is a per-shape `order` field, not array position — concurrent reorders can't
  // corrupt the collection (see docs/adr/0001). Same rule as the Yjs example.
  return edit(doc, (c) => {
    c.shapes[id] = {
      id,
      x: Math.round(Math.random() * 340),
      y: Math.round(Math.random() * 320),
      color,
      label: id.slice(2),
      order: topOrder(c.shapes),
    }
  })
}

export function moveShape(doc: Doc, id: string, x: number, y: number): [Doc, string[], A.Patch[]] {
  return edit(doc, (c) => {
    const s = c.shapes[id]
    if (s) {
      s.x = x
      s.y = y
    }
  })
}

export function bringToFront(doc: Doc, id: string): [Doc, string[], A.Patch[]] {
  return edit(doc, (c) => {
    const s = c.shapes[id]
    if (s) s.order = topOrder(c.shapes)
  })
}

export function deleteShape(doc: Doc, id: string): [Doc, string[], A.Patch[]] {
  return edit(doc, (c) => {
    if (c.shapes[id]) delete c.shapes[id]
  })
}

// One entry in the debug panel's patch log: the native Automerge `Patch[]` from a single
// change/merge, plus where it came from (local / peer / server).
export interface PatchEntry {
  id: number
  origin: string
  at: number
  patches: A.Patch[]
}

export function formatPatch(p: A.Patch): string {
  const loc = `/${p.path.join('/')}`
  const value = 'value' in p ? ` = ${JSON.stringify(p.value)}` : ''
  return `${p.action} ${loc}${value}`
}
