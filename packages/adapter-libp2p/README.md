# @super-line/adapter-libp2p

Decentralized, broker-less [libp2p](https://libp2p.io) (gossipsub) adapter for
[**super-line**](https://super-line.dogar.biz/) — fan out rooms, topics, the cluster
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

// builds a libp2p node for you; pick how peers find each other with `discovery`
const adapter = await createLibp2pAdapter({ discovery: 'mdns' }) // LAN / docker network — zero addresses

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
```

Every node joins one shared gossipsub topic; each node filters incoming messages by its local
subscriptions, so `subscribe`/`unsubscribe` are local with no network round-trip. At-most-once
delivery, matching the library's model.

## Discovery strategies

`discovery` decides how the built-in node finds its peers. Discovered peers are dialed
automatically, so the gossipsub mesh forms with no extra wiring. Pass an array to combine
strategies (e.g. mDNS on the LAN plus one cross-subnet seed). Omit it for a single node, or a
seed that others point at.

```ts
// 1. mDNS — multicast on a LAN or docker network. No addresses, no stable identity needed.
await createLibp2pAdapter({ discovery: 'mdns' })
await createLibp2pAdapter({ discovery: { mdns: { interval: 5_000 } } }) // @libp2p/mdns options pass through

// 2. bootstrap — a fixed list of seed multiaddrs. Persist identity so seed peer IDs stay stable.
await createLibp2pAdapter({
  listen: ['/ip4/0.0.0.0/tcp/9001'],
  identity: { path: '/var/lib/app/p2p' },
  discovery: { bootstrap: ['/dns4/seed-1/tcp/9001/p2p/12D3Koo…'] },
})

// 3. relay — for nodes behind NAT that can't reach each other directly. Point at a public
//    circuit-relay-v2 node (run one with createRelayNode). Adds the WebSocket + circuit
//    transports, a /p2p-circuit listen address, pubsub peer-discovery, and DCUtR.
await createLibp2pAdapter({ discovery: { relay: '/dns4/relay.example.com/tcp/9000/ws/p2p/12D3Koo…' } })
```

### Running a relay

The one public rendezvous node a `{ relay }` strategy points at. **Persist its identity** — every
server's `relay` address embeds this node's peer ID.

```ts
import { createRelayNode } from '@super-line/adapter-libp2p'

const relay = await createRelayNode({ port: 9000, identity: { path: './relay-key' } })
console.log(relay.getMultiaddrs().map(String)) // hand this to every server's discovery.relay
```

The relay is a discovery + rendezvous coordinator, **not** a data relay: it bridges the peer-discovery
topic and brokers first contact, then servers mesh over their own direct (DCUtR-upgraded) connections.

## How it works

- **Fan-out** — one shared gossipsub topic + a small binary envelope. The adapter delivers to its
  own local members directly (no dependency on gossipsub `emitSelf`).
- **Presence** — a gossip-replicated directory (deltas + periodic snapshots, monotonic-seq
  reconcile, heartbeat/TTL liveness) powers `srv.cluster.*` / `srv.isOnline`. On by default;
  pass `presence: false` to disable.

## Options

| Option | Meaning |
| --- | --- |
| `node` | Bring your own started libp2p node (must expose a gossipsub `pubsub` service). The adapter won't stop a node it didn't create, and `discovery`/`listen`/… don't apply — you own its topology. |
| `discovery` | How the built-in node finds peers: `'mdns'`, `{ mdns }`, `{ bootstrap }`, `{ relay }`, or an array of these. Omit for no discovery (single node / seed). |
| `listen` | Listen multiaddrs for the built-in node (default `/ip4/0.0.0.0/tcp/0`). Seeds need a FIXED port. |
| `transport` | `'tcp'` (default) or `'ws'`. |
| `identity` | A raw `PrivateKey`, `{ path }` to load-or-create a persistent Ed25519 key, or omit for an ephemeral key (warns unless discovery is mDNS/relay-only). |
| `presence` | `false` to disable, or `{ snapshotIntervalMs, livenessTtlMs }` to tune. |
| `topic` | The shared gossipsub topic (default `'super-line/v1'`). |

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [scaling & adapters](https://super-line.dogar.biz/how-to/choose-an-adapter)
- 🧩 Example: [`scaling-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
