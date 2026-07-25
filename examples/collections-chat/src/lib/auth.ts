import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import type { AuthClientOptions } from '@super-line/plugin-auth/react'
import { chat } from '@/contract'

const WS_URL = `ws://${location.hostname}:8791`

// One session for the whole app. `<SuperLineAuthProvider>` in main.tsx connects immediately (restoring any
// persisted session), swaps the live client between the `guest` and `user` roles as you sign in / out, and
// feeds it to every hook — see @super-line/plugin-auth.
export const authOptions = {
  authedRole: 'user',
  // called first as `guest` ({}), then as `user` ({ token }) after login. The `as 'user'` is the one concession
  // for the guest↔authed swap (the helper types both as the authed role).
  connect: ({ role, params }) =>
    createSuperLineClient(chat, { transport: webSocketClientTransport({ url: WS_URL }), role: role as 'user', params }),
} satisfies AuthClientOptions<typeof chat, 'user'>
