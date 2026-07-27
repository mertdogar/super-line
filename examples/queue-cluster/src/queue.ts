import { setTimeout as delay } from 'node:timers/promises'
import * as z from 'zod'
import { queue } from '@super-line/plugin-queue'

const nodeName = process.env.NODE_NAME ?? 'queue-node'

export const queueKit = queue({
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 250),
  shutdownGraceMs: 10_000,
  queues: {
    report: {
      input: z.object({
        reportId: z.string(),
        source: z.enum(['bootstrap', 'cron', 'web']),
      }),
      result: z.object({
        reportId: z.string(),
        processedBy: z.string(),
        completedAt: z.number(),
      }),
      concurrency: 2,
      leaseMs: 10_000,
      timeoutMs: 30_000,
      retry: {
        maxAttempts: 3,
        backoff: { type: 'exponential', delayMs: 500, maxDelayMs: 5_000, jitter: 0.1 },
      },
      worker: async ({ reportId }, { attempt, signal }) => {
        console.log(`[${nodeName}] started ${reportId} (attempt ${attempt})`)
        await delay(1_500, undefined, { signal })
        console.log(`[${nodeName}] completed ${reportId}`)
        return { reportId, processedBy: nodeName, completedAt: Date.now() }
      },
    },
  },
})
