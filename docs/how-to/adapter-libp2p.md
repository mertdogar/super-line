# libp2p adapter

Broker-less and decentralized: nodes peer directly over a [libp2p](https://libp2p.io) gossipsub mesh — no Redis, no central service. The heavyweight decentralized option (NAT traversal, encrypted transports, peer discovery) for self-hosted / edge deployments. Provided by `@super-line/adapter-libp2p`.

```bash
pnpm add @super-line/adapter-libp2p
```

::: tip Adapter, not transport
This is the *server↔server* fan-out adapter. For *client↔server* libp2p/WebRTC connections, see the [libp2p transport](/how-to/transport-libp2p) — they're independent, and you can use either, both, or neither.
:::

## Setup

Server code is unchanged; only the adapter line differs. Pick how peers find each other with `discovery`:

```ts
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const adapter = await createLibp2pAdapter({ discovery: 'mdns' }) // LAN / docker — zero addresses
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
```

The factory is **async** — it starts the node and joins the gossipsub mesh before returning a ready adapter.

## Discovery strategies

Discovered peers are dialed automatically — the mesh forms with no extra wiring. Combine strategies by passing an array; omit `discovery` for a single node or a seed others point at.

```ts
// mDNS — multicast on a LAN / docker network. No addresses, no stable identity needed.
await createLibp2pAdapter({ discovery: 'mdns' })
await createLibp2pAdapter({ discovery: { mdns: { interval: 5_000 } } }) // @libp2p/mdns options pass through

// bootstrap — a fixed list of seed multiaddrs. Persist identity so seed peer IDs stay stable.
await createLibp2pAdapter({
  listen: ['/ip4/0.0.0.0/tcp/9001'],
  identity: { path: '/var/lib/app/p2p' },
  discovery: { bootstrap: ['/dns4/seed-1/tcp/9001/p2p/12D3Koo…'] },
})

// relay — nodes behind NAT that can't reach each other directly, meshing through a public relay.
await createLibp2pAdapter({ discovery: { relay: '/dns4/relay.example.com/tcp/9000/ws/p2p/12D3Koo…' } })
```

The `{ relay }` strategy adds the WebSocket + circuit transports, a `/p2p-circuit` listen address, pubsub peer-discovery, and DCUtR. Run the public rendezvous node with `createRelayNode` — **persist its identity**, since every server's `relay` address embeds its peer ID:

```ts
import { createRelayNode } from '@super-line/adapter-libp2p'
const relay = await createRelayNode({ port: 9000, identity: { path: './relay-key' } })
console.log(relay.getMultiaddrs().map(String)) // hand this to every server's discovery.relay
```

The relay coordinates discovery and first contact; it is **not** a data relay — servers mesh over their own direct (DCUtR-upgraded) connections.

## Behavior notes

- It fans out rooms, topics, and the [cluster event bus](/how-to/cluster-event-bus) the same way; a gossip-replicated directory backs `srv.cluster.*` / `srv.isOnline`.
- **Trade-off vs. Redis:** broker-less and decentralized, at the cost of **eventually-consistent presence** and **best-effort delivery** (no central store).
- **ESM-only** (libp2p is ESM-only).
- For `bootstrap`, run **≥2 stable seed nodes** and **persist their identity** (`identity.path`) so bootstrap lists stay valid across restarts. mDNS and relay re-discover peers after a restart, so an ephemeral identity is fine there.

Run it: the [`scaling-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p) and [`react-chat-cluster-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster-libp2p) examples are the Redis clusters with the broker **deleted** — the nodes peer over libp2p instead.

Next: [RabbitMQ](/how-to/adapter-rabbitmq) · back to [Choose an adapter](/how-to/choose-an-adapter).
