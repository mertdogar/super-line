# ZeroMQ adapter

The lightest way to go broker-less: nodes peer directly over plain [ZeroMQ](https://zeromq.org) sockets — no extra service, and no full libp2p stack. Provided by `@super-line/adapter-zeromq`.

```bash
pnpm add @super-line/adapter-zeromq
```

::: warning ESM-only · native addon
ESM-only, and a native addon (Node-only).
:::

## Setup — mesh

Bind a `PUB`, connect a `SUB` to every peer. Discovery is just addresses — no registry:

```ts
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const adapter = await createZeroMqAdapter({
  bind: 'tcp://0.0.0.0:9101',
  peers: ['tcp://node-2:9101', 'tcp://node-3:9101'],
})
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
```

ZeroMQ's `connect` is lazy and auto-reconnecting, so nodes can start in any order.

## Larger fleets — proxy mode

A static mesh is O(N²) connections. For a larger or dynamic fleet, swap the mesh for a central **forwarder** — one `npx super-line-zeromq-proxy` process — and point nodes at it:

```ts
const adapter = await createZeroMqAdapter({
  mode: 'proxy',
  frontendUrl: 'tcp://proxy:5557', // node PUBs connect here
  backendUrl: 'tcp://proxy:5558',  // node SUBs connect here
})
```

## Behavior notes

- Fans out rooms, topics, and the [cluster event bus](/how-to/cluster-event-bus) the same way, with a **gossip-replicated** directory backing `srv.cluster.*` / `srv.isOnline` (eventually-consistent, like libp2p — no central store).
- **At-most-once delivery**, matching the rest of the library.
- Mesh mode is gorgeous at a handful of nodes; reach for **proxy mode (or Redis)** for large / dynamic fleets.

Run it: the [`react-chat-cluster-zeromq`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster-zeromq) example is the Redis chat cluster with the broker **deleted** — same app, one fewer service.

Back to [Choose an adapter](/how-to/choose-an-adapter).
