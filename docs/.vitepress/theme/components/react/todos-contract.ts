import * as z from 'zod'
import { defineContract } from '@super-line/core'

// One typed table, declared on the contract — the server validates every write
// against this schema, and RowOf<typeof app, 'todos'> flows to both ends.
export const app = defineContract({
  collections: {
    todos: {
      schema: z.object({
        id: z.string(),
        text: z.string(),
        done: z.boolean(),
        createdAt: z.number(),
      }),
      key: 'id',
    },
  },
  roles: { user: { clientToServer: {} } },
})
