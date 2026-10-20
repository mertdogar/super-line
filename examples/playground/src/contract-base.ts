import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

const nodeSchema = z.object({ nodeId: z.string(), nodeName: z.string(), connections: z.number(), alive: z.boolean() })
const connSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  role: z.string(),
  userId: z.string().optional(),
  transport: z.string().optional(),
  connectedAt: z.number(),
})

// `srv.toUser(id).emit` takes SHARED events — it reaches every device of a user, on whichever node holds them.
export const nudgeEvent = { nudge: { payload: z.object({ from: z.string(), fromNode: z.string(), text: z.string() }) } }

export const presenceRequests = {
  whereAmI: { input: z.void(), output: z.object({ node: z.string(), nodeId: z.string(), connId: z.string() }) },
  cluster: { input: z.void(), output: z.object({ nodes: z.array(nodeSchema), connections: z.array(connSchema) }) },
  nudge: { input: z.object({ userId: z.string(), text: z.string().min(1).max(200) }), output: z.object({ online: z.boolean() }) },
}

// A small issue tracker: three row collections, linked to each other and to plugin-auth's `users` by advisory
// `references`. The Control Center draws them as a schema graph; the browser joins them with TanStack DB.
export const trackerCollections = {
  projects: {
    schema: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
    key: 'id',
    references: { ownerId: 'users' },
  },
  tasks: {
    schema: z.object({
      id: z.string(),
      projectId: z.string(),
      title: z.string().min(1).max(120),
      status: z.enum(['todo', 'doing', 'done']),
      priority: z.number().int().min(1).max(3),
      assigneeId: z.string().nullable(),
      createdAt: z.number(),
    }),
    key: 'id',
    references: { projectId: 'projects', assigneeId: 'users' },
  },
  comments: {
    schema: z.object({ id: z.string(), taskId: z.string(), authorId: z.string(), text: z.string().min(1).max(500), createdAt: z.number() }),
    key: 'id',
    references: { taskId: 'tasks', authorId: 'users' },
  },
} as const

/**
 * The playground without queues: identity (plugin-auth), chat (plugin-chat), the tracker collections and the
 * presence requests. The Cloudflare Durable Object serves exactly this. The browser always holds the full `app`
 * contract (contract.ts), a superset, and hides the Queues panel there — a queue request reaching this node
 * would answer NOT_FOUND.
 */
export const base = defineContract({
  collections: trackerCollections,
  shared: { serverToClient: nudgeEvent },
  roles: { user: { clientToServer: presenceRequests } },
  plugins: [authContract(), chatContract()],
})
