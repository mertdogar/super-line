import { z } from 'zod'
import { defineContract } from '@super-line/core'

// Roles are the authorization boundary: `secret` exists only on the admin surface,
// so a user client can't even name it — and the server rejects it with NOT_FOUND.
export const api = defineContract({
  shared: {
    clientToServer: {
      whoami: { input: z.object({}), output: z.object({ user: z.string(), role: z.string() }) },
    },
  },
  roles: {
    user: {},
    admin: {
      clientToServer: {
        secret: { input: z.object({}), output: z.object({ data: z.string() }) },
      },
    },
  },
})
