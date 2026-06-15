import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  shared: {
    serverToClient: {
      // shared event so room.broadcast can deliver it
      message: {
        payload: z.object({
          room: z.string(),
          id: z.string(),
          text: z.string(),
          from: z.string(),
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
          output: z.object({ ok: z.boolean(), count: z.number() }),
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
