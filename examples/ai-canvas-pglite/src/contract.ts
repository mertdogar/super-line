import { z } from 'zod'
import { defineContract } from '@super-line/core'

// The scene itself is off-contract — it lives in a Store (the `stores` option) and syncs on its
// own. The contract carries one typed request: ask the server-side AI agent to co-write the board.
export const api = defineContract({
  roles: {
    user: {
      clientToServer: {
        agentEdit: {
          input: z.object({ prompt: z.string().min(1) }),
          output: z.object({
            summary: z.string(),
            actions: z.array(z.object({ tool: z.string(), detail: z.string() })),
          }),
        },
      },
    },
  },
})
