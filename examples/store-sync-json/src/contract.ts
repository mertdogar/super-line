import { z } from 'zod'
import { defineContract } from '@super-line/core'

// The shared JSON document itself is off-contract — it lives in a Store (configured via the
// `stores` option), not here. The contract only carries a normal typed request used for the
// "server is a co-writer" demo.
export const api = defineContract({
  roles: {
    user: {
      clientToServer: {
        // ask the server to mutate the shared doc itself (a server co-write)
        nudge: { input: z.void(), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})
