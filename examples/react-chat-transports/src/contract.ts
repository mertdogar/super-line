import { z } from 'zod'
import { defineContract } from '@super-line/core'

// One contract — the chat works identically no matter which wire the browser dials over.
// `via` is the transport the server saw the connection arrive on: proof the same handlers ran
// over WebSocket, HTTP, or libp2p.
export const chat = defineContract({
  shared: {
    serverToClient: {
      // shared so `room.broadcast('message', …)` can deliver it to every member
      message: {
        payload: z.object({
          room: z.string(),
          id: z.string(),
          text: z.string(),
          from: z.string(),
          via: z.string(), // the wire the sender's connection used
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
          output: z.object({ ok: z.boolean(), count: z.number(), via: z.string() }),
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
