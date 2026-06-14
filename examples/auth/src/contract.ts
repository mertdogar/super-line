import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  messages: {
    whoami: { input: z.object({}), output: z.object({ user: z.string() }) },
    secret: { input: z.object({}), output: z.object({ data: z.string() }) },
  },
  events: {},
  topics: {},
})
