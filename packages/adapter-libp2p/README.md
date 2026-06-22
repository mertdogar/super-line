# @super-line/adapter-libp2p

Decentralized, broker-less [libp2p](https://libp2p.io) (gossipsub) adapter for
[**super-line**](https://mertdogar.github.io/super-line/) — fan out rooms, topics, the cluster
event bus, and cluster presence across multiple server processes with **no central broker**.
A drop-in alternative to [`@super-line/adapter-redis`](https://www.npmjs.com/package/@super-line/adapter-redis).

```bash
pnpm add @super-line/adapter-libp2p
```

> **ESM-only** — libp2p is ESM-only, so this package ships ESM only (Node 18+, `"type": "module"`).

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { api } from './contract'

// builds a libp2p node for you; persist identity so seed peer IDs survive restarts
const adapter = await createLibp2pAdapter({
  listen: ['/ip4/0.0.0.0/tcp/9001'],
  bootstrap: ['/dns4/seed-1/tcp/9001/p2p/12D3Koo…'], // seed multiaddrs
  identity: { path: '/var/lib/app/p2p' },
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
console.log('p2p:', adapter.node.getMultiaddrs().map(String)) // share a seed's address for bootstrap lists
```

Every node joins one shared gossipsub topic; each node filters incoming messages by its local
subscriptions, so `subscribe`/`unsubscribe` are local with no network round-trip. At-most-once
delivery, matching the library's model.

## How it works

- **Fan-out** — one shared gossipsub topic + a small binary envelope. The adapter delivers to its
  own local members directly (no dependency on gossipsub `emitSelf`).
- **Presence** — a gossip-replicated directory (deltas + periodic snapshots, monotonic-seq
  reconcile, heartbeat/TTL liveness) powers `srv.cluster.*` / `srv.isOnline`. On by default;
  pass `presence: false` to disable.
- **Discovery** — bootstrap-only: dial a fixed list of seed multiaddrs. Run ≥2 seeds, or list
  every peer for a small cluster. Persist identity (`identity: { path }`) so seed peer IDs are stable.

## Options

| Option | Meaning |
| --- | --- |
| `node` | Bring your own started libp2p node (must expose a gossipsub `pubsub` service). The adapter won't stop a node it didn't create. |
| `listen` | Listen multiaddrs for the built-in node (default `/ip4/0.0.0.0/tcp/0`). Seeds need a FIXED port. |
| `bootstrap` | Seed multiaddrs (incl. `/p2p/<peerId>`) to dial on startup. |
| `transport` | `'tcp'` (default) or `'ws'`. |
| `identity` | A raw `PrivateKey`, `{ path }` to load-or-create a persistent Ed25519 key, or omit for an ephemeral key (warns). |
| `presence` | `false` to disable, or `{ snapshotIntervalMs, livenessTtlMs }` to tune. |
| `topic` | The shared gossipsub topic (default `'super-line/v1'`). |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [scaling & adapters](https://mertdogar.github.io/super-line/guide/scaling-adapters)
- 🧩 Example: [`scaling-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
