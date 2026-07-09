# @super-line/core

Shared core for [**super-line**](https://super-line.dogar.biz/) — a strictly-typed realtime data bus for TypeScript: one contract for every pattern on the wire (requests · events · subscriptions · synced state). This package holds the pieces both ends import: `defineContract`, runtime validation, the `SuperLineError` model, the wire `Frame` protocol, the `Serializer` / `Adapter` interfaces, and the **transport** and **Store** seams the rest of the ecosystem plugs into.

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

## Persisted state — collections

Persisted, synced state ships as **collections** — declared on the contract and validated on every write: typed **rows** (`CollectionStore`: [`/collections-memory`](https://www.npmjs.com/package/@super-line/collections-memory), [`/collections-sqlite`](https://www.npmjs.com/package/@super-line/collections-sqlite), [`/collections-pglite`](https://www.npmjs.com/package/@super-line/collections-pglite)) and CRDT **documents** (`CrdtCollectionStore`: [`/collections-crdt-memory`](https://www.npmjs.com/package/@super-line/collections-crdt-memory), [`/collections-crdt-libsql`](https://www.npmjs.com/package/@super-line/collections-crdt-libsql), [`/collections-crdt-pglite`](https://www.npmjs.com/package/@super-line/collections-crdt-pglite)). ADR-0007/0008 retired the legacy off-contract `store(n)` family.

Core retains three small primitives the CRDT client `DocHandle` reuses:

- `StoreChange` — the opaque change envelope core relays between the doc replica halves without parsing (`{ id, update, origin }`).
- `ResourceReplica` — the reactive local-replica shape (`set` / `update` / `delete(path)` / `applyRemote` / `seed` / `reset` / `applyDelete`).
- `removeAtPath(root, path)` — surgical, merge-friendly key removal.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 The contract model: <https://super-line.dogar.biz/concepts/the-contract>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
