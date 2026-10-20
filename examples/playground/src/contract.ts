import * as z from 'zod'
import { defineContract, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'
import { queueKit } from './queue.js'

const nodeSchema = z.object({ nodeId: z.string(), nodeName: z.string(), connections: z.number(), alive: z.boolean() })
const connSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  role: z.string(),
  userId: z.string().optional(),
  transport: z.string().optional(),
  connectedAt: z.number(),
})
const jobSchema = z.object({
  id: z.string(),
  queue: z.string(),
  label: z.string(),
  status: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  node: z.string().optional(),
  error: z.string().optional(),
  scheduled: z.boolean(),
  updatedAt: z.number(),
})
const scheduleSchema = z.object({ id: z.string(), queue: z.string(), cron: z.string(), enabled: z.boolean(), nextRunAt: z.number() })
const jobId = z.object({ jobId: z.string() })

// Identity (users, sessions, presence, the `guest` role) is plugin-auth's; channels/messages are
// plugin-chat's; queue jobs/schedules/slots are plugin-queue's. The `user` block is the playground's own
// surface: introspection, a cross-node nudge, and the queue operations a browser may perform — queue
// collections are deny-all, so a browser only ever reaches them through requests like these.
export const app = defineContract({
  shared: {
    serverToClient: {
      // Both ride `srv.toUser(id).emit`, which takes SHARED events — it reaches every device of a user,
      // on whichever node holds them.
      nudge: { payload: z.object({ from: z.string(), fromNode: z.string(), text: z.string() }) },
      jobProgress: { payload: z.object({ jobId: z.string(), label: z.string(), node: z.string(), text: z.string() }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        whereAmI: { input: z.void(), output: z.object({ node: z.string(), nodeId: z.string(), connId: z.string() }) },
        cluster: { input: z.void(), output: z.object({ nodes: z.array(nodeSchema), connections: z.array(connSchema) }) },
        nudge: { input: z.object({ userId: z.string(), text: z.string().min(1).max(200) }), output: z.object({ online: z.boolean() }) },
        enqueueReport: {
          input: z.object({ label: z.string().min(1).max(80), failRate: z.number().min(0).max(1), count: z.number().int().min(1).max(20) }),
          output: z.object({ jobIds: z.array(z.string()) }),
        },
        listJobs: { input: z.void(), output: z.array(jobSchema) },
        cancelJob: { input: jobId, output: z.object({ status: z.string() }) },
        retryJob: { input: jobId, output: jobId },
        listSchedules: { input: z.void(), output: z.array(scheduleSchema) },
        setSchedule: { input: z.object({ id: z.string(), enabled: z.boolean() }), output: z.object({ ok: z.boolean() }) },
        triggerSchedule: { input: z.object({ id: z.string() }), output: jobId },
      },
    },
  },
  plugins: [authContract(), chatContract(), queueKit.contract],
})

export type User = RowOf<typeof app, 'users'>
export type UserPresence = RowOf<typeof app, 'userPresence'>
export type Message = RowOf<typeof app, 'messages'>
