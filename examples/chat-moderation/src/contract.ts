import { z } from 'zod'
import { defineContract, defineSurface, mergeSurfaces } from '@super-line/core'
import { moderationSurface } from './moderation/surface.js'

// The plain chat surface (join / send / presence), as its own fragment so we can merge the plugin's.
const chatUser = defineSurface({
  clientToServer: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean(), count: z.number() }) },
    send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
  },
  serverToClient: {
    presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true },
  },
})

export const chat = defineContract({
  shared: {
    serverToClient: {
      message: {
        payload: z.object({ room: z.string(), id: z.string(), text: z.string(), from: z.string(), at: z.number() }),
      },
    },
  },
  roles: {
    // the app's surface + the plugin's surface, woven into one role
    user: mergeSurfaces(chatUser, moderationSurface),
  },
})
