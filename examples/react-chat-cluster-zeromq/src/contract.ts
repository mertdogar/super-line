import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  shared: {
    serverToClient: {
      // shared event so room.broadcast can deliver it — and, with the Redis adapter, fan it
      // out across nodes. `node` is the server that handled the send: proof it crossed servers.
      message: {
        payload: z.object({
          room: z.string(),
          id: z.string(),
          text: z.string(),
          from: z.string(),
          node: z.string(),
          at: z.number(),
        }),
      },
    },
  },
  roles: {
    user: {
      clientToServer: {
        join: {
          input: z.object({ room: z.string() }),
          // `node` tells the tab which server it landed on.
          output: z.object({ ok: z.boolean(), count: z.number(), node: z.string() }),
        },
        send: {
          input: z.object({ room: z.string(), text: z.string() }),
          output: z.object({ id: z.string() }),
        },
      },
      serverToClient: {
        presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true },
      },
    },
  },
})
