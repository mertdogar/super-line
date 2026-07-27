# @super-line/plugin-queue

Durable, at-least-once jobs and cluster-wide cron schedules backed by super-line collections.

```ts
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { queue } from '@super-line/plugin-queue'
import { createSuperLineServer } from '@super-line/server'

const queueKit = queue({
  queues: {
    sendEmail: {
      input: z.object({ to: z.email() }),
      result: z.object({ messageId: z.string() }),
      concurrency: 3,
      worker: async ({ to }, { signal }) => {
        const messageId = await sendEmail(to, { signal })
        return { messageId }
      },
    },
  },
})

const contract = defineContract({
  roles: { user: {} },
  plugins: [queueKit.contract],
})

const server = createSuperLineServer(contract, {
  // ...
  plugins: [queueKit.plugin],
})

await queueKit.enqueue('sendEmail', { to: 'hello@example.com' })
await queueKit.schedules.create({
  queue: 'sendEmail',
  cron: '0 9 * * *',
  timezone: 'Europe/Berlin',
  input: { to: 'hello@example.com' },
})
```

Workers are server-only and every configured queue requires one. Concurrency is declarative and enforced with durable slot rows. Claims, lease renewals, and completion use atomic conditional batches with a fencing `runId`.

The memory and SQLite collection backends coordinate one node. Use the PGlite/Postgres collection backend for cluster-wide concurrency and cron scheduling; its conditional batches serialize on central Postgres. The adapter wake channel only reduces latency—durable polling remains the correctness path.

Execution is at least once. Workers should be idempotent and honor `WorkerContext.signal`. Queue collections have deny-all client policies; server code and the privileged inspector can access them.
