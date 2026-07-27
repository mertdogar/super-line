# Queues and workers — `@super-line/plugin-queue`

`@super-line/plugin-queue` is a paired, server-only plugin for durable, at-least-once jobs and cron schedules. Call `queue()` once with your queue definitions. It returns the contract fragment and runtime plugin for their corresponding plugin arrays.

```bash
pnpm add @super-line/plugin-queue
```

## Wire it in

```ts [queue.ts]
import * as z from 'zod'
import { queue } from '@super-line/plugin-queue'

export const queueKit = queue({
  queues: {
    sendEmail: {
      input: z.object({ to: z.email() }),
      result: z.object({ messageId: z.string() }),
      concurrency: 3,
      retry: { maxAttempts: 3 },
      worker: async ({ to }, { signal }) => ({ messageId: await sendEmail(to, { signal }) }),
    },
  },
})
```

```ts [contract.ts]
export const app = defineContract({ roles: { admin: {} }, plugins: [queueKit.contract] })
```

```ts [server.ts]
const collections = sqliteCollections({ file: 'app.db', collections: app.collections ?? {} })
createSuperLineServer(app, {
  nodeKey: 'mailer-1',
  collections,
  authenticate: authenticateAdmin,
  plugins: [queueKit.plugin],
})
```

Every queue has typed input/results, a worker, and declarative concurrency. There is no `setConcurrency()` API: all worker nodes must use the same queue definition. Honor the worker `AbortSignal` for cancellation, timeouts, and shutdown.

The contract fragment adds `queueJobs`, `queueSchedules`, and `queueSlots`. They have deny-all client policies. Call the kit only from trusted server code:

```ts
const job = await queueKit.enqueue('sendEmail', { to: 'ada@example.com' })
await queueKit.cancel(job.id, { reason: 'recipient unsubscribed' })
```

Memory and SQLite coordinate one node. Use Postgres-backed `pgliteCollections` for cluster-wide claims, cron, and concurrency. Jobs are at least once, so make external effects idempotent. See [Enqueue and observe jobs](/how-to/queue-jobs), [Schedule periodic jobs](/how-to/queue-schedules), and [Run queues across a cluster](/how-to/queue-clusters). Every export is in the generated [API reference](/reference/).
