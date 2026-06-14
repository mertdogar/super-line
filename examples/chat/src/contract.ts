import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    say: {
      input: z.object({ room: z.string(), text: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
  events: {
    message: z.object({ room: z.string(), text: z.string(), from: z.string() }),
  },
  topics: {
    presence: z.object({ room: z.string(), count: z.number() }),
  },
})
