import { z } from 'zod'
import { defineContract } from '@super-line/core'

// One contract, three fan-out flavors that all cross process boundaries via the
// shared Redis adapter:
//   1. message  — a room broadcast a client triggers via `say` (server -> all clients, any node)
//   2. announce — a topic one node publishes on a timer (server -> subscribed clients, any node)
//   3. stats    — a serverToServer event nodes use to gossip their connection counts
export const sync = defineContract({
  shared: {
    serverToClient: {
      message: { payload: z.object({ from: z.string(), text: z.string() }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        // `from` is client-supplied here to keep the demo trivial; a real app would
        // derive identity from `authenticate` instead of trusting the client.
        say: { input: z.object({ from: z.string(), text: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        announce: { payload: z.object({ from: z.string(), text: z.string() }), subscribe: true },
      },
    },
  },
  serverToServer: {
    stats: z.object({ node: z.string(), conns: z.number() }),
  },
})
