import { z } from 'zod'
import { defineContract } from '@super-line/core'

// ONE contract. The server implements it once; the client calls it the same way —
// no matter which wire (WebSocket, HTTP, libp2p) carries the bytes.
export const api = defineContract({
  roles: {
    user: {
      clientToServer: {
        // echo returns `via` = the transport the request arrived on, proving the SAME handler
        // ran over different wires.
        echo: {
          input: z.object({ text: z.string() }),
          output: z.object({ text: z.string(), via: z.string() }),
        },
      },
      serverToClient: {
        announce: { payload: z.object({ msg: z.string() }) },
      },
    },
  },
})
