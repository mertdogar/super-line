import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import type { AuthClientOptions } from '@super-line/plugin-auth/react'
import { app } from '@/contract'

const WS_URL = `ws://${location.hostname}:8792`

// One session for the whole app: connects as `guest`, swaps to `user` on sign-in. `<SuperLineAuthProvider>`
// in main.tsx builds the client from these and feeds it to every hook — there is no bridge to write.
// crdtCollections is the client-side CRDT engine — required to `open` the canvas/doc resources.
export const authOptions = {
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(app, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: role as 'user',
      params,
      crdtCollections: crdtCollectionsClient(),
    }),
} satisfies AuthClientOptions<typeof app, 'user'>
