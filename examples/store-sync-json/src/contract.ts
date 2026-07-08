import { z } from 'zod'
import { defineContract } from '@super-line/core'

// The shared JSON document is a CRDT document collection (ADR-0007): declared on the contract, opened by id,
// and validated on every write. A permissive object schema keeps the "edit arbitrary JSON" feel while still
// flowing through validate-before-commit. The contract also carries a typed request for the co-write demo.
export const api = defineContract({
  collections: {
    docs: { schema: z.record(z.string(), z.any()), crdt: { mode: 'document' } },
  },
  roles: {
    user: {
      clientToServer: {
        // ask the server to mutate the shared doc itself (a server co-write)
        nudge: { input: z.void(), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})
