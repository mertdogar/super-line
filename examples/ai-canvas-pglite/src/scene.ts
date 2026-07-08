import { z } from 'zod'

// One shared, server-seeded scene everybody (and the agent) edits.
export const SCENE_ID = 'board'

// The scene lives in a CRDT document collection (ADR-0007): declared on the contract with this schema, so
// the server validate-before-commits every write against it. `document` mode (on the contract's `crdt`
// option) makes it a recursive CRDT — concurrent edits to different shapes/fields MERGE, not clobber.
export const shapeSchema = z.object({
  x: z.number(),
  y: z.number(),
  color: z.string(),
  label: z.string(),
  order: z.number(),
})
export const sceneSchema = z.object({ shapes: z.record(z.string(), shapeSchema) })

export type Shape = z.infer<typeof shapeSchema>
export type Scene = z.infer<typeof sceneSchema>

// A partial scene write — what update() merges in. The doc merges deeply, so a write
// can carry just the changed fields of one shape.
export type ScenePatch = { shapes: Record<string, Partial<Shape>> }

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
