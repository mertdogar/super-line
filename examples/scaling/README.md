# scaling — a real multi-node cluster

Boots a genuine cluster with Docker Compose — **Redis + a Caddy load balancer + 3 server nodes + 6 client containers** — and lets you watch rooms, topics, and the cluster event bus fan out across separate processes. This is the "more than one process behind a load balancer" story from the [scaling guide](https://mertdogar.github.io/super-line/guide/scaling-adapters), for real.

## Run it

```bash
cd examples/scaling
docker compose up        # builds the image once, then boots the cluster
```

Caddy round-robins each client's WebSocket onto a different node; no sticky sessions, because all room/presence state lives in Redis.

## What you'll see

Three fan-out flows scroll by, each crossing process boundaries via the shared Redis adapter:

```
scaling-node-1   | [node-1] + conn (2 local)
scaling-node-2   | [node-2] peer node-1 → 2 conns          # ← cluster event bus: stats gossip
scaling-client-3 | scaling-client-3 ← message  "msg #4" (from scaling-client-1)   # ← room broadcast, cross-node
scaling-client-5 | scaling-client-5 ← announce "announce #2"                       # ← topic from node-1, reaches all nodes
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
- `src/server.ts` — one node. Auto-joins each connection to `global`, broadcasts on `say`, gossips `stats` over the bus (`publish`/`subscribe`), and (on `node-1` only) publishes `announce`.
- `src/client.ts` — one of the six replicas: subscribes, listens, and sends on a timer.
- `Caddyfile` — `reverse_proxy` across the three nodes with `lb_policy round_robin`.
