# Tutorial 8 · Run your first durable job

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <strong>8 · Run your first durable job</strong></p>

Use `@super-line/plugin-queue` when work must survive the request that created it. In this tutorial you add a typed report worker, enqueue work from a request, and receive the durable job id immediately.

## 1 · Construct one queue kit

```ts
import * as z from 'zod'
import { queue } from '@super-line/plugin-queue'

export const queueKit = queue({
  queues: {
    report: {
      input: z.object({ reportId: z.string() }),
      result: z.object({ reportId: z.string(), completedAt: z.number() }),
      concurrency: 2,
      worker: async ({ reportId }, { signal }) => {
        await generateReport(reportId, { signal })
        return { reportId, completedAt: Date.now() }
      },
    },
  },
})
```

The worker receives an `AbortSignal`; pass it to work that can be cancelled or timed out. The queue factory is called once and returns both plugin halves.

## 2 · Put the halves in their matching plugin arrays

```ts
export const app = defineContract({
  roles: { dashboard: dashboardSurface },
  plugins: [queueKit.contract],
})

createSuperLineServer(app, {
  nodeKey: 'reports-1',
  collections: memoryCollections(),
  authenticate: () => ({ role: 'dashboard' as const, ctx: {} }),
  plugins: [queueKit.plugin],
})
```

The queue collections are added to the contract but remain deny-all for clients. `memoryCollections()` keeps this lesson single-node; switch to Postgres shared authority for a cluster.

## 3 · Enqueue from a request

```ts
createReport: async ({ reportId }) => {
  const job = await queueKit.enqueue('report', { reportId })
  return { jobId: job.id }
}
```

The client gets `{ jobId }` after the durable insert, while a worker later claims a slot and runs the report. To show progress in a browser, add a separate request that maps `queueKit.list()` to a safe summary and poll it. Do not subscribe the browser to queue collections.

## What happened

`concurrency: 2` creates two durable slots. A worker claims one slot and one ready job together, then records a validated result. Failures retry by policy; jobs are at least once, so external effects must be idempotent.

Next: [Enqueue and observe jobs](/how-to/queue-jobs) · [Schedule periodic jobs](/how-to/queue-schedules) · [Run queues across a cluster](/how-to/queue-clusters).
