import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { sceneSchema } from './scene.js'

// The scene is a CRDT document collection (ADR-0007) declared on the contract — typed and validated on
// every write, opened by id. The contract also carries one typed request: ask the server-side AI agent to
// co-write the board.
export const api = defineContract({
  collections: {
    scene: { schema: sceneSchema, crdt: { mode: 'document' } },
  },
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
