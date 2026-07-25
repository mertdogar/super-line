import { createSuperLineClient } from '@super-line/client'
import type { AuthClientOptions } from '@super-line/plugin-auth/react'
import { chat } from '@/contract'
import { transport } from '@/lib/transport'

// One session for the whole app. `<SuperLineAuthProvider>` in main.tsx connects immediately (restoring any
// persisted session) and swaps the live client between the `guest` and `user` roles as you sign in / out.
//
// `transport` is whatever this tab dialed — WebSocket, HTTP or libp2p. Nothing below this line knows or
// cares which: plugin-auth, plugin-chat and every hook sit above the transport seam.
export const authOptions = {
  authedRole: 'user',
  // called first as `guest` ({}), then as `user` ({ token }) after login. The `as 'user'` is the one
  // concession for the guest↔authed swap (the helper types both as the authed role).
  connect: ({ role, params }) => createSuperLineClient(chat, { transport, role: role as 'user', params }),
} satisfies AuthClientOptions<typeof chat, 'user'>
