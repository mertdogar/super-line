import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createAuth } from '@super-line/plugin-auth/react'
import { app } from '@/contract'

const WS_URL = `ws://${location.hostname}:8792`

// One auth client for the whole app: connects as `guest`, swaps to `user` on sign-in.
export const { AuthProvider, useAuth } = createAuth({
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(app, { transport: webSocketClientTransport({ url: WS_URL }), role: role as 'user', params }),
})
