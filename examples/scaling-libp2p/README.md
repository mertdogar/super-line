# example: scaling-libp2p (decentralized, broker-less)

The same multi-node cluster as [`scaling`](../scaling), but with **no Redis** — the nodes
peer directly over [libp2p](https://libp2p.io) gossipsub via
[`@super-line/adapter-libp2p`](../../packages/adapter-libp2p). One shared mesh fans out all
three flows across separate processes:

1. **`message`** — a room broadcast a client triggers via `say` (server → all clients, any node)
2. **`announce`** — a topic `node-1` publishes on a timer (server → subscribed clients, any node)
3. **`stats`** — a shared topic used as the cluster event bus (server → server gossip of conn counts)

## Run it

```bash
cd examples/scaling-libp2p && docker compose up
```

Three server nodes peer over libp2p (`P2P_PORT` 9001), a Caddy load balancer round-robins
six client WebSockets across them (`:8085`), and there is **no broker container**. Watch a
client's `say` come back out on every other client, `node-1`'s `announce` reach all of them,
and each node log its peers' connection counts gossiped over the bus.

## How discovery works here

Every node needs to find the others. This demo derives a **deterministic Ed25519 key from each
node name**, so each node can compute the others' peer IDs and build the bootstrap list with no
registry:

```ts
const bootstrap = await Promise.all(
  NODES.filter((n) => n !== NODE).map(
    async (n) => `/dns4/${n}/tcp/${P2P_PORT}/p2p/${peerIdFromPrivateKey(await keyFor(n))}`,
  ),
)
const adapter = await createLibp2pAdapter({ identity: myKey, listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`], bootstrap })
```

> **Demo shortcut.** Deterministic keys keep the example registry-free. A real deployment
> persists each node's key and runs ≥2 stable **seed** nodes (or lists every peer for a small
> cluster). Persist with `createLibp2pAdapter({ identity: { path: '/var/lib/app/p2p' } })` so a
> seed's peer ID — and therefore its bootstrap multiaddr — survives restarts.

## Redis vs. libp2p

Both adapters implement the same `Adapter` contract, so server code is identical — only the
adapter line changes. Redis is a simple central broker; libp2p is broker-less and decentralized.
See the [scaling & adapters guide](https://mertdogar.github.io/super-line/guide/scaling-adapters).
