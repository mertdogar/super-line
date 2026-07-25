// The TUI's auth wiring: mirrors examples/chat-supervisor/src/lib/auth.ts but the URL comes from
// config (no location.hostname) and the access token persists to a file (no localStorage). A
// factory so the smoke test can point it at an isolated cache path.
//
// The TUI drives its session IMPERATIVELY too (smoke.tsx signs up and reads `auth.client` outside
// React), so it builds the vanilla `authClient` and hands the instance to the provider to ADOPT —
// the provider never closes what it did not build, so the script keeps driving it after render.

import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { authClient, type TokenStorage } from '@super-line/plugin-auth/client'
import { app } from '../contract'
import { config } from './config'
import { fileStorage } from './storage'

export function createTuiAuth(opts: { url?: string; storage?: TokenStorage } = {}) {
  const url = opts.url ?? config.url
  const storage = opts.storage ?? fileStorage(config.cachePath)
  return authClient<typeof app, 'user'>({
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

/** One session shared by the entry point, the screenshot script and the smoke test, which also drive it directly. */
export const auth = createTuiAuth()
