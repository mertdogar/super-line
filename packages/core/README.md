# @super-line/core

Shared core for [**super-line**](https://mertdogar.github.io/super-line/) — a strictly-typed realtime data bus for TypeScript: one contract for every pattern on the wire (requests · events · subscriptions · synced state). This package holds the pieces both ends import: `defineContract`, runtime validation, the `SuperLineError` model, the wire `Frame` protocol, the `Serializer` / `Adapter` interfaces, and the **transport** and **Store** seams the rest of the ecosystem plugs into.

```bash
pnpm add @super-line/core zod
```

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  shared: {
    serverToClient: { message: { payload: z.object({ text: z.string() }) } },
  },
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
  },
})
```

The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role**, then implemented by [`@super-line/server`](https://www.npmjs.com/package/@super-line/server) and called by [`@super-line/client`](https://www.npmjs.com/package/@super-line/client).

## Transport seam

The client↔server wire is a **pluggable transport** — WebSocket is just the default. Core owns the `Frame` protocol and serializer; a transport only carries opaque bytes over a logical connection and hides physical churn (reconnects, SSE's dual channel, libp2p signaling). The interfaces live here so every transport package implements the same contract:

- `RawConn` — a live logical connection (`send` / `writable` / `onMessage` / `onClose` / `onDrain` / `close` / `terminate`); symmetric across server and client.
- `Handshake` — the normalized connect payload handed to `authenticate` (`transport`, `headers`, `query`, optional `peer`, `raw` escape hatch), replacing the raw `IncomingMessage`.
- `ServerTransport` — `start({ authenticate, onConnection })` / `stop()`; authenticates at its native moment and surfaces only accepted connections.
- `ClientTransport` — `connect(handshakeParams, hooks)` → `RawConn`.

Implementations: [`@super-line/transport-websocket`](https://www.npmjs.com/package/@super-line/transport-websocket) (default), [`/transport-http`](https://www.npmjs.com/package/@super-line/transport-http) (SSE / long-poll), [`/transport-libp2p`](https://www.npmjs.com/package/@super-line/transport-libp2p), and [`/transport-loopback`](https://www.npmjs.com/package/@super-line/transport-loopback) (in-memory, for tests).

## Store seam

Synced state ships as a pluggable **Store** pair, like a transport. Core relays opaque `StoreChange`s between the halves and enforces access — it never parses `update`. The type spine lives here:

- `ServerStore` — persistence + consistency model + change-notify (`read` / `create` / `apply` / `delete` / `onChange`, optional `onDelete` / `open`); `clustering: 'relay' | 'self'` and optional `model: 'lww' | 'crdt'`.
- `ServerReplica` — a reactive **server-side** co-writer over one Resource (`set` / `update` / `delete` / `subscribe`), returned by `ServerStore.open` and surfaced to apps as `srv.store(ns).open(id)`.
- `ClientStore` / `ResourceReplica` — the reactive client half: a local replica per opened Resource (`set` / `update` / `delete(path)` / `applyRemote` / `seed` / `applyDelete`).
- `Resource` / `AccessRules` / `Perms` / `Principal` / `StoreChange` — the persisted unit, its deny-by-default ACL, and the opaque change envelope.
- Wire frames `SChangeFrame` (mutation relay) and `SDeleteFrame` (cluster-wide deletion fan-out), plus the `removeAtPath(root, path)` helper for surgical, merge-friendly key removal.

Implementations: [`@super-line/store-memory`](https://www.npmjs.com/package/@super-line/store-memory), [`/store-sqlite`](https://www.npmjs.com/package/@super-line/store-sqlite), [`/store-sync`](https://www.npmjs.com/package/@super-line/store-sync) (CRDT), [`/store-sync-libsql`](https://www.npmjs.com/package/@super-line/store-sync-libsql), [`/store-pglite`](https://www.npmjs.com/package/@super-line/store-pglite), and [`/store-sync-pglite`](https://www.npmjs.com/package/@super-line/store-sync-pglite).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 The contract model: <https://mertdogar.github.io/super-line/guide/the-contract>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
