# scaling-rabbitmq — a real multi-node cluster over RabbitMQ

Boots a genuine cluster with Docker Compose — **RabbitMQ + a Caddy load balancer + 3 server nodes + 6 client containers** — and lets you watch rooms, topics, and the cluster event bus fan out across separate processes. Same demo as [`examples/scaling`](../scaling), with RabbitMQ as the substrate instead of Redis: channels become routing keys on a `direct` exchange, so the broker selectively routes each message only to the nodes that subscribed.

## Run it

```bash
cd examples/scaling-rabbitmq
docker compose up        # builds the image once, then boots the cluster
```

Caddy round-robins each client's WebSocket onto a different node; no sticky sessions, because all room/topic fan-out and presence ride RabbitMQ. The RabbitMQ management UI is at <http://localhost:15672> (`superline` / `superline`) — watch the `super-line` exchange, the per-node exclusive queues, and their bindings appear live.

## What you'll see

Three fan-out flows scroll by, each crossing process boundaries via the shared RabbitMQ adapter:

```
scaling-rabbitmq-node-1   | [node-1] + conn (2 local)
scaling-rabbitmq-node-2   | [node-2] peer node-1 → 2 conns          # ← cluster event bus: stats gossip
scaling-rabbitmq-client-3 | scaling-rabbitmq-client-3 ← message  "msg #4" (from scaling-rabbitmq-client-1)
scaling-rabbitmq-client-5 | scaling-rabbitmq-client-5 ← announce "announce #2"
```

1. **Messages** — every client calls `say(...)` on a timer; its node broadcasts to room `global`, and clients on **all** nodes receive it.
2. **Stats** — nodes gossip their connection counts over the **cluster event bus** (`srv.publish('stats', …)` + `srv.subscribe('stats', …)`); peers log them, skipping their own echo via `meta.from`.
3. **Announce** — `node-1` publishes a topic every 5s; every client receives it regardless of which node holds its socket.

## Poke it yourself

Caddy is exposed on `ws://localhost:8080`. Point your own client at it and watch your messages reach the containerized clients:

```ts
import { createSuperLineClient } from '@super-line/client'
import { sync } from './src/contract.js'

const c = createSuperLineClient(sync, { url: 'ws://localhost:8080', role: 'user' })
c.on('message', (m) => console.log('got', m))
await c.say({ from: 'me', text: 'hello cluster' })
```

## Scale it

```bash
docker compose up --scale client=12     # pile on more load
```

## Stop

`Ctrl-C`, then:

```bash
docker compose down
```

## How it maps to super-line

- `src/contract.ts` — one contract: a shared `message` event, a `say` request, an `announce` topic, and a shared `stats` topic used as the cluster event bus.
- `src/server.ts` — one node. `createRabbitmqAdapter(...)` is awaited (it connects + declares its topology before returning a ready adapter). Auto-joins each connection to `global`, broadcasts on `say`, gossips `stats` over the bus, and (on `node-1` only) publishes `announce`.
- `src/client.ts` — one of the six replicas: subscribes, listens, and sends on a timer.
- `Caddyfile` — `reverse_proxy` across the three nodes with `lb_policy round_robin`.
- `docker-compose.yml` — RabbitMQ (with a custom default user, since the built-in `guest` is refused over non-loopback connections) + Caddy + 3 nodes + 6 clients.
