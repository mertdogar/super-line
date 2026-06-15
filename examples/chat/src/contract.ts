import { z } from 'zod'
import { defineContract } from '@super-line/core'

// Two kinds of client share one room: humans (`user`) and an AI participant (`agent`).
// They get different surfaces but the same shared `join` and `message` event.
export const chat = defineContract({
  shared: {
    clientToServer: {
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // shared event so a mixed-role room can broadcast it to everyone
      message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        say: {
          input: z.object({ room: z.string(), text: z.string() }),
          output: z.object({ id: z.string() }),
        },
      },
    },
    agent: {
      clientToServer: {
        announce: {
          input: z.object({ room: z.string(), text: z.string() }),
          output: z.object({ id: z.string() }),
        },
      },
    },
  },
})
