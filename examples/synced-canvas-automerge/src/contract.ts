import { z } from 'zod'
import { defineContract } from '@super-line/core'

// Same shape as the Yjs example's contract — super-line just relays opaque base64 blobs and
// never parses the document. The only difference is the payload is Automerge change bytes
// (an array, since one edit can produce several changes) instead of a Yjs update.
export const canvas = defineContract({
  shared: {
    serverToClient: {
      // CRDT change(s) for a doc; declared `shared` so room.broadcast can deliver it.
      // `origin` tags the patch: a relayed client edit is 'peer', the server's own
      // co-writer edit is 'server'.
      change: {
        payload: z.object({ docId: z.string(), changes: z.array(z.string()), origin: z.enum(['peer', 'server']) }),
      },
    },
  },
  roles: {
    user: {
      clientToServer: {
        // join a doc's room and get its full current state (base64 Automerge save) to catch up
        joinDoc: {
          input: z.object({ docId: z.string() }),
          output: z.object({ snapshot: z.string() }),
        },
        // push local change(s); the server applies them to the canonical doc
        pushChange: {
          input: z.object({ docId: z.string(), changes: z.array(z.string()) }),
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
