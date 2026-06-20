# example: scaling-zeromq (brokerless mesh)

The same multi-node cluster as [`scaling`](../scaling), but with **no Redis** — the nodes peer
directly over a [ZeroMQ](https://zeromq.org) mesh via
[`@super-line/adapter-zeromq`](../../packages/adapter-zeromq). One shared mesh fans out all
three flows across separate processes:

1. **`message`** — a room broadcast a client triggers via `say` (server → all clients, any node)
2. **`announce`** — a topic `node-1` publishes on a timer (server → subscribed clients, any node)
3. **`stats`** — a shared topic used as the cluster event bus (server → server gossip of conn counts)

## Run it

```bash
cd examples/scaling-zeromq && docker compose up
```

Three server nodes peer over ZeroMQ (`ZMQ_PORT` 9101), a Caddy load balancer round-robins six
client WebSockets across them (`:8085`), and there is **no broker container**. Watch a client's
`say` come back out on every other client, `node-1`'s `announce` reach all of them, and each
node log its peers' connection counts gossiped over the bus.

## How discovery works here

Each node binds its own PUB and connects a SUB to every peer — discovery is just **plain DNS
names** on the compose network, no peer IDs, no keys, no registry:

```ts
const peers = NODES.filter((n) => n !== NODE).map((n) => `tcp://${n}:${ZMQ_PORT}`)
const adapter = await createZeroMqAdapter({ bind: `tcp://0.0.0.0:${ZMQ_PORT}`, peers })
```

ZeroMQ's `connect` is lazy and auto-reconnecting, so the nodes can start in any order and a
restarted node rejoins on its own.

> **Mesh vs. forwarder.** This demo uses **mesh** mode — beautiful at a handful of nodes (O(N²)
> connections, static peer list). For a larger or dynamic fleet, run a central forwarder instead:
> `npx super-line-zeromq-proxy` and point nodes at it with
> `createZeroMqAdapter({ mode: 'proxy', frontendUrl, backendUrl })`.

## Redis vs. libp2p vs. ZeroMQ

All three adapters implement the same `Adapter` contract, so server code is identical — only the
adapter line changes. Redis is a central broker; libp2p is decentralized gossip; ZeroMQ is a
brokerless mesh (or a lightweight forwarder). See the
[scaling & adapters guide](https://mertdogar.github.io/super-line/guide/scaling-adapters).
