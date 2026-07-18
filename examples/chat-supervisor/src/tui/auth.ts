// The TUI's auth wiring: mirrors examples/chat-supervisor/src/lib/auth.ts but the URL comes from
// config (no location.hostname) and the session token persists to a file (no localStorage). A
// factory so the smoke test can point it at an isolated cache path.

import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { createAuth } from '@super-line/plugin-auth/react'
import type { TokenStorage } from '@super-line/plugin-auth/client'
import { app } from '../contract'
import { config } from './config'
import { fileStorage } from './storage'

export function createTuiAuth(opts: { url?: string; storage?: TokenStorage } = {}) {
  const url = opts.url ?? config.url
  const storage = opts.storage ?? fileStorage(config.cachePath)
  return createAuth<typeof app, 'user'>({
    authedRole: 'user',
    storage,
    connect: ({ role, params }) =>
      createSuperLineClient(app, {
        transport: webSocketClientTransport({ url }),
        role: role as 'user',
        params,
        crdtCollections: crdtCollectionsClient(),
      }),
  })
}

export const { AuthProvider, useAuth, auth } = createTuiAuth()
