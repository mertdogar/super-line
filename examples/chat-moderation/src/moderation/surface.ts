import { z } from 'zod'
import { defineSurface } from '@super-line/core'

// The moderation surface — the typed contract fragment the plugin ships. The host merges it into a
// role (see ../contract.ts); in return, these clientToServer keys are subtracted from the host's
// `implement()` obligation at compile time (the plugin owns their handlers). Because a plugin can't
// inject typed surface on its own, shipping this alongside the plugin is the pairing discipline.
export const moderationSurface = defineSurface({
  clientToServer: {
    'mod.mute': { input: z.object({ user: z.string() }), output: z.object({ muted: z.array(z.string()) }) },
    'mod.unmute': { input: z.object({ user: z.string() }), output: z.object({ muted: z.array(z.string()) }) },
    'mod.list': { input: z.object({}), output: z.object({ muted: z.array(z.string()) }) },
  },
  serverToClient: {
    // pushed to the affected user when their mute status changes, so their client can show a banner
    'mod.status': { payload: z.object({ muted: z.boolean(), by: z.string().optional() }) },
  },
})
