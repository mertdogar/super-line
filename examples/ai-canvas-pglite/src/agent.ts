import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { SuperLineError, type CrdtServerReplica } from '@super-line/core'
import { COLORS, newShapeId, readShapes, topOrder, type Scene } from './scene.js'

// Cheap, env-overridable. Plain "provider/model" string → AI SDK routes it through the AI Gateway.
const MODEL = process.env.MODEL ?? 'anthropic/claude-haiku-4.5'

export interface AgentAction {
  tool: string
  detail: string
}

// Run one agent turn against a server-side CrdtServerReplica (srv.collection('scene').open(id)). Each tool
// maps to a doc primitive — update() (merge) or delete(path) (the only key-removing op) — so the agent's
// edits land as CRDT deltas that fan out to every tab and merge with whatever a human is doing live.
export async function runAgent(
  replica: CrdtServerReplica,
  prompt: string,
): Promise<{ summary: string; actions: AgentAction[] }> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new SuperLineError('BAD_REQUEST', 'Set AI_GATEWAY_API_KEY to use the agent (copy .env.example to .env).')
  }

  const actions: AgentAction[] = []
  const scene = (): Scene | undefined => replica.getSnapshot() as Scene | undefined
  const has = (id: string): boolean => Boolean(scene()?.shapes?.[id])

  const tools = {
    add_shape: tool({
      description: 'Add a new square shape to the board.',
      inputSchema: z.object({
        x: z.number().describe('left position, 0..380'),
        y: z.number().describe('top position, 0..380'),
        color: z.string().describe('hex color, e.g. #3b82f6'),
        label: z.string().max(6).describe('short label shown on the shape'),
      }),
      execute: async ({ x, y, color, label }) => {
        const id = newShapeId()
        replica.update({ shapes: { [id]: { x, y, color, label, order: topOrder(scene()) } } })
        actions.push({ tool: 'add_shape', detail: `${id} ${color} "${label}" @(${x},${y})` })
        return { id }
      },
    }),
    move_shape: tool({
      description: 'Move an existing shape to a new position.',
      inputSchema: z.object({ id: z.string(), x: z.number(), y: z.number() }),
      execute: async ({ id, x, y }) => {
        if (!has(id)) return { ok: false, error: 'no such shape' }
        replica.update({ shapes: { [id]: { x, y } } })
        actions.push({ tool: 'move_shape', detail: `${id} → (${x},${y})` })
        return { ok: true }
      },
    }),
    recolor_shape: tool({
      description: "Change an existing shape's color.",
      inputSchema: z.object({ id: z.string(), color: z.string().describe('hex color') }),
      execute: async ({ id, color }) => {
        if (!has(id)) return { ok: false, error: 'no such shape' }
        replica.update({ shapes: { [id]: { color } } })
        actions.push({ tool: 'recolor_shape', detail: `${id} → ${color}` })
        return { ok: true }
      },
    }),
    delete_shape: tool({
      description: 'Delete a shape from the board.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        if (!has(id)) return { ok: false, error: 'no such shape' }
        // delete(path) is the only key-removing surface — atomic in-process, so it never clobbers
        // concurrent edits to sibling shapes (update() merges and can't remove a key).
        replica.delete(['shapes', id])
        actions.push({ tool: 'delete_shape', detail: id })
        return { ok: true }
      },
    }),
  }

  const board =
    readShapes(scene())
      .map((s) => `${s.id}: (${s.x},${s.y}) ${s.color} "${s.label}"`)
      .join('\n') || '(empty board)'

  const result = await generateText({
    model: MODEL,
    stopWhen: stepCountIs(8),
    system: [
      'You edit a shared visual canvas by calling tools. Each shape is a labelled square.',
      'Positions: x and y are 0..380, top-left origin. Prefer the palette: ' + COLORS.join(', ') + '.',
      'Make exactly the edits the user asks for, then stop. Do not narrate.',
      'Current board:',
      board,
    ].join('\n'),
    prompt,
    tools,
  })

  const summary = actions.length
    ? `${actions.length} edit${actions.length === 1 ? '' : 's'}: ${actions.map((a) => a.tool).join(', ')}`
    : result.text.trim() || 'no changes made'
  return { summary, actions }
}
