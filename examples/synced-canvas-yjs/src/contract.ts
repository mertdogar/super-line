import { z } from 'zod'
import { defineContract } from '@super-line/core'

// super-line carries the CRDT as opaque, base64-encoded update bytes. The bus never
// parses the document — it just relays blobs and fans them out per room. That's what
// keeps super-line CRDT-agnostic: swap Yjs for any other CRDT and this contract is
// unchanged.
export const canvas = defineContract({
  shared: {
    serverToClient: {
      // a CRDT update for a doc; declared `shared` so room.broadcast can deliver it.
      // `origin` lets clients tag the patch: a relayed client edit is 'peer', the server's
      // own co-writer edit is 'server'.
      update: {
        payload: z.object({ docId: z.string(), update: z.string(), origin: z.enum(['peer', 'server']) }),
      },
    },
  },
  roles: {
    user: {
      clientToServer: {
        // join a doc's room and get its full current state (base64) to catch up
        joinDoc: {
          input: z.object({ docId: z.string() }),
          output: z.object({ snapshot: z.string() }),
        },
        // push a local CRDT update; the server merges it into the canonical doc
        pushUpdate: {
          input: z.object({ docId: z.string(), update: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
        // the "server is a co-writer" demo: ask the server to mutate the doc itself
        serverNudge: {
          input: z.object({ docId: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
})
