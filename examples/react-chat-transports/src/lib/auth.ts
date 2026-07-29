import { createSuperLineClient } from '@super-line/client'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { devtoolsPlugin } from '@super-line/plugin-devtools'
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
  //
  // `devtoolsPlugin()` is per-CLIENT, and this callback runs once per session — so signing in builds a
  // second instance while the first is still live, which is exactly what the DevTools panel shows: two
  // clients in one timeline, the guest closing only after the user connection is confirmed.
  //
  // `crdtCollectionsClient()` is the universal client engine for CRDT document collections — universal
  // because the client only ever merges opaque deltas, so the same engine pairs with whichever backend
  // the server runs (Postgres + Electric under compose, in-memory without it).
  connect: ({ role, params }) =>
    createSuperLineClient(chat, {
      transport,
      role: role as 'user',
      params,
      crdtCollections: crdtCollectionsClient(),
      plugins: [devtoolsPlugin()],
    }),
} satisfies AuthClientOptions<typeof chat, 'user'>
