import { z } from 'zod'
import { defineContract } from '@super-line/core'

// Same chat contract as react-chat-cluster-libp2p — the app is deliberately unchanged. Only the
// connectivity (relay + webrtc + pubsub discovery) is new, which is the whole point of this example.
export const chat = defineContract({
  shared: {
    serverToClient: {
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
