import { z } from 'zod'
import { defineContract } from '@super-line/core'

// The headline here is SERVER subscribers reacting to each other across nodes. Every node
// publishes `bump` on a timer; every node subscribes and converges a shared tally — its own
// bumps arrive in-process (local echo, no Redis hop), peers' bumps arrive over Redis.
export const cluster = defineContract({
  shared: {
    serverToClient: {
      // the bus event: any node publishes, every node's server code subscribes
      bump: { payload: z.object({ node: z.string() }), subscribe: true },
      // a client-facing snapshot of the cluster-wide tally (node-1 publishes it)
      total: {
        payload: z.object({ total: z.number(), perNode: z.record(z.string(), z.number()) }),
        subscribe: true,
      },
    },
  },
  roles: { watcher: {} },
})
