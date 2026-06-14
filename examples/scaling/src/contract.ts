import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const sync = defineContract({
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
  events: {
    message: z.object({ room: z.string(), text: z.string() }),
  },
  topics: {
    feed: z.object({ seq: z.number() }),
  },
})
