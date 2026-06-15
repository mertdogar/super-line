import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const ops = defineContract({
  shared: {
    clientToServer: {
      // a trivial request just to confirm the connection is up before we introspect
      hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // a push event — delivered via toUser/toConn across nodes
      notice: { payload: z.object({ text: z.string() }) },
      // a SERVER→CLIENT request — the server asks, the client answers (client.implement)
      confirm: {
        input: z.object({ question: z.string() }),
        output: z.object({ approved: z.boolean() }),
      },
    },
  },
  roles: {
    user: {},
  },
})
