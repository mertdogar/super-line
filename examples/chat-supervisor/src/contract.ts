import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

// The two channel-resource doc shapes (PLAN-chat-resources): id-keyed maps merge concurrent
// edits cleanly — user drags a note while the agent adds another and both land. Presence-tolerant
// (ADR-0008): the concurrently-edited records carry .catch() (so a transient partial merge never
// rejects an innocent write) — which also means a bad agent write INSIDE them is accepted, not
// rejected. `title` is deliberately catch-LESS: set once at init, never edited concurrently, it's
// the field a bad write_resource actually bounces off with a VALIDATION the model can read.
// Inside ONE string field it's whole-string last-writer-wins, so the doc editor works in blocks.
export const canvasSchema = z.object({
  title: z.string(),
  items: z
    .record(z.string(), z.object({ x: z.number(), y: z.number(), color: z.string(), text: z.string() }))
    .catch({}),
})
export const docSchema = z.object({
  title: z.string(),
  blocks: z.record(z.string(), z.object({ order: z.number(), text: z.string() })).catch({}),
})

export type CanvasDoc = z.infer<typeof canvasSchema>
export type TextDoc = z.infer<typeof docSchema>

/**
 * The app is the two plugins (identity from plugin-auth, channels + streamed agent turns from
 * plugin-chat) plus the host's OWN CRDT collections — the chat plugin turns them channel-native
 * via its resource kind registry (see server.ts).
 */
export const app = defineContract({
  collections: {
    canvases: { schema: canvasSchema, crdt: { mode: 'document' } },
    docs: { schema: docSchema, crdt: { mode: 'document' } },
  },
  roles: { user: {}, guest: {} },
  plugins: [authContract(), chatContract()],
})

export type User = RowOf<typeof app, 'users'>
export type Message = RowOf<typeof app, 'messages'>
export type MessagePart = RowOf<typeof app, 'messageParts'>
export type ResourceRow = RowOf<typeof app, 'resources'>
export type FeedMessage = Message
