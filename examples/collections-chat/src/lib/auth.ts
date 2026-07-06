import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createAuth } from '@super-line/plugin-auth/react'
import { chat } from '@/contract'

const WS_URL = `ws://${location.hostname}:8791`

// One auth client for the whole app. It connects immediately (restoring any persisted session), and swaps the
// live super-line client between the `guest` and `user` roles as you sign in / out — see @super-line/plugin-auth.
export const { AuthProvider, useAuth } = createAuth({
  authedRole: 'user',
  // called first as `guest` ({}), then as `user` ({ token }) after login. The `as 'user'` is the one concession
  // for the guest↔authed swap (useAuth().client is typed as the `user` client).
  connect: ({ role, params }) =>
    createSuperLineClient(chat, { transport: webSocketClientTransport({ url: WS_URL }), role: role as 'user', params }),
})
