import * as z from 'zod'
import { queue } from '@super-line/plugin-queue'

// Declared WITHOUT workers: the browser imports the contract, and the contract imports this, so no worker
// code may live here. server.ts binds each worker with `queueKit.queue(name).setWorker(...)`.
export const queueKit = queue({
  pollIntervalMs: 250,
  queues: {
    // Cluster-wide concurrency 2: with both nodes polling, never more than two run at once.
    report: {
      input: z.object({ label: z.string(), failRate: z.number().min(0).max(1), userId: z.string().nullable() }),
      result: z.object({ processedBy: z.string() }),
      concurrency: 2,
      leaseMs: 10_000,
      retry: { maxAttempts: 3, backoff: { type: 'exponential', delayMs: 500, maxDelayMs: 4_000 } },
    },
    // Fed by the chat `sendMessage.after` hook on `/bot …`; the worker streams the reply into the channel.
    botReply: {
      input: z.object({ channelId: z.string(), prompt: z.string() }),
      result: z.object({ messageId: z.string(), processedBy: z.string() }),
      concurrency: 4,
      retry: { maxAttempts: 1 },
    },
  },
})
