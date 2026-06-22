# libp2p adapter

Broker-less and decentralized: nodes peer directly over a [libp2p](https://libp2p.io) gossipsub mesh — no Redis, no central service. The heavyweight decentralized option (NAT traversal, encrypted transports, peer discovery) for self-hosted / edge deployments. Provided by `@super-line/adapter-libp2p`.

```bash
pnpm add @super-line/adapter-libp2p
```

::: tip Adapter, not transport
This is the *server↔server* fan-out adapter. For *client↔server* libp2p/WebRTC connections, see the [libp2p transport](./transport-libp2p) — they're independent, and you can use either, both, or neither.
:::

## Setup

Server code is unchanged; only the adapter line differs:

```ts
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const adapter = await createLibp2pAdapter({
  listen: ['/ip4/0.0.0.0/tcp/9001'],
  bootstrap: ['/dns4/seed-1/tcp/9001/p2p/12D3Koo…'], // seed multiaddrs
  identity: { path: '/var/lib/app/p2p' },            // stable peer ID across restarts
})
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
```

The factory is **async** — it starts the node and joins the gossipsub mesh before returning a ready adapter.

## Behavior notes

- It fans out rooms, topics, and the [cluster event bus](./cluster-event-bus) the same way; a gossip-replicated directory backs `srv.cluster.*` / `srv.isOnline`.
- **Trade-off vs. Redis:** broker-less and decentralized, at the cost of **eventually-consistent presence** and **best-effort delivery** (no central store).
- **ESM-only** (libp2p is ESM-only).
- Run **≥2 stable seed nodes** and **persist their identity** (`identity.path`) so bootstrap lists stay valid across restarts.

Run it: the [`scaling-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p) and [`react-chat-cluster-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster-libp2p) examples are the Redis clusters with the broker **deleted** — the nodes peer over libp2p instead.

Next: [RabbitMQ](./adapter-rabbitmq) · back to [Choose your backbone](./scaling-adapters).
