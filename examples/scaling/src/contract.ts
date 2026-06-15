import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const sync = defineContract({
  shared: {
    serverToClient: { message: { payload: z.object({ room: z.string(), text: z.string() }) } },
  },
  roles: {
    user: {
      clientToServer: {
        join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        feed: { payload: z.object({ seq: z.number() }), subscribe: true },
      },
    },
  },
  // node <-> node: coordination across the cluster, fanned out by the same adapter
  serverToServer: {
    stats: z.object({ node: z.string(), conns: z.number() }),
  },
})
