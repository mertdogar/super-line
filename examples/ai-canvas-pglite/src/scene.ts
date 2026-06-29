import type { DocOptions } from '@super-line/store-sync'

// One shared, server-seeded scene everybody (and the agent) edits.
export const SCENE_ID = 'board'

export interface Shape {
  x: number
  y: number
  color: string
  label: string
  order: number
}

export type Scene = { shapes: Record<string, Shape> }

// A partial scene write — what update() merges in. The Store merges deeply, so a write
// can carry just the changed fields of one shape.
export type ScenePatch = { shapes: Record<string, Partial<Shape>> }

// The SAME resolver feeds both store halves: `document` mode = recursive CRDT, so concurrent
// edits to different shapes (or different fields of one shape) MERGE instead of clobbering.
// Import this from both syncStoreServer() and syncStoreClient() so the two halves can't drift.
export const resolveOptions = (_id: string): DocOptions => ({ mode: 'document' })

export const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

export function readShapes(scene: Scene | undefined): Array<Shape & { id: string }> {
  return Object.entries(scene?.shapes ?? {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => a.order - b.order)
}

export function topOrder(scene: Scene | undefined): number {
  let max = 0
  for (const s of Object.values(scene?.shapes ?? {})) max = Math.max(max, s.order ?? 0)
  return max + 1
}

export function newShapeId(): string {
  return `S_${Math.random().toString(36).slice(2, 8)}`
}
