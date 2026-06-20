# Scaling & adapters

A single super-line server uses an in-memory adapter — rooms and topics fan out within that one process. To run **more than one process** (behind a load balancer), give every server a **shared adapter** so fan-out crosses nodes.

## The adapter seam

Rooms and topics all compile down to channel pub/sub behind the `Adapter` interface. Swap the implementation; the rest of your code is unchanged.

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'

const srv = createSuperLineServer(api, {
  server, authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'),
})
```

Point every server process at the same Redis. Now `room.broadcast`, `srv.publish` / `forRole(r).publish`, and the cluster event bus all reach clients (and peers) on **any** node. At-most-once delivery is preserved.

::: tip No Redis for a single node
You don't need an adapter for one process — the default in-memory adapter handles it. Add Redis only when you scale out.
:::

## Decentralized: libp2p (no broker)

Don't want to run a broker at all? [`@super-line/adapter-libp2p`](https://www.npmjs.com/package/@super-line/adapter-libp2p) implements the same `Adapter` contract over a [libp2p](https://libp2p.io) gossipsub mesh — the nodes peer directly, with no Redis. Server code is unchanged; only the adapter line differs:

```ts
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'

const adapter = await createLibp2pAdapter({
  listen: ['/ip4/0.0.0.0/tcp/9001'],
  bootstrap: ['/dns4/seed-1/tcp/9001/p2p/12D3Koo…'], // seed multiaddrs
  identity: { path: '/var/lib/app/p2p' }, // stable peer ID across restarts
})
const srv = createSuperLineServer(api, { server, authenticate, adapter })
```

It fans out rooms, topics, and the bus the same way, and a gossip-replicated directory backs `srv.cluster.*` / `srv.isOnline`. The trade-off vs. Redis: broker-less and decentralized, at the cost of eventually-consistent presence and best-effort delivery (no central store). It's **ESM-only** (libp2p is ESM-only). Run ≥2 stable seed nodes and persist their identity so bootstrap lists stay valid.

## Broker-routed: RabbitMQ

Already run RabbitMQ, or want the broker to do **selective routing**? [`@super-line/adapter-rabbitmq`](https://www.npmjs.com/package/@super-line/adapter-rabbitmq) implements the same `Adapter` contract over RabbitMQ. Channels become routing keys on one durable `direct` exchange; each node owns an exclusive, auto-delete queue and binds only the channels it has local members for — so the broker delivers each message only to the nodes that subscribed.

```ts
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'

const adapter = await createRabbitmqAdapter('amqp://localhost:5672')
const srv = createSocketServer(api, { server, authenticate, adapter })
```

The factory is **async** (it connects and declares its topology before returning a ready adapter). It's built on [`rabbitmq-client`](https://www.npmjs.com/package/rabbitmq-client), so a dropped connection auto-reconnects and the node's bindings are replayed. RabbitMQ has no shared key-value store, so — like libp2p — presence is **gossip-replicated** over the same exchange (eventually consistent; a crashed node's connections clear after a liveness TTL, ~30s by default, vs Redis's broker-enforced key expiry; graceful shutdown clears promptly). Delivery is at-most-once (transient messages, no acks, no persistence). One caveat Redis doesn't have: AMQP routing keys cap at **255 bytes**, so a channel name (embedding room / user / topic) longer than that is rejected with a clear error.

(See the **Which adapter?** tip below, after the ZeroMQ option, for how to choose between all four.)

## The cluster event bus

A bus channel is just a **shared topic**. One declaration types all three subscribers at once — server-side listeners, client-side subscribers, and the publish itself:

```ts
defineContract({
  shared: {
    serverToClient: {
      announce: { payload: z.object({ msg: z.string() }), subscribe: true },
    },
  },
  roles: { /* … */ },
})
```

Any node publishes; the publish fans out to **three kinds of subscriber** at once:

```ts
// server-side, cluster-wide subscribe — fires for a publish from ANY node,
// including this one (local echo, delivered in-process, no Redis/WS round-trip).
const off = srv.subscribe('announce', (data, { from }) => {
  if (from === srv.nodeId) return // self-exclude if you only want peers
  applyAnnounce(data)
})

srv.publish('announce', { msg: 'hello cluster' }) // any node publishes
off() // unsubscribe
```

`server.publish(name, data)` is the existing `srv.publish` — it works on shared topics (role topics use `srv.forRole(r).publish`). `server.subscribe(name, cb)` is the new server-side, cluster-wide subscribe; the callback receives `(data, { from })` where `from` is the origin node id, and it returns an unsubscribe fn. Shared topics only (role-scoped `server.subscribe` is deferred). Connected clients subscribe over WS with the unchanged `client.subscribe(name, (data) => …)` — client callbacks get `(data)` only, no `from`.

One `server.publish` delivers to: (1) **same-node** `server.subscribe` listeners, directly in-process, no hop; (2) **other nodes'** `server.subscribe` listeners, via the adapter; (3) **subscribed clients** on any node, over WS.

Inbound events from **other nodes** are validated against the topic's payload schema; local echo is trusted (not re-validated). A throwing listener or a bad inbound payload routes to `opts.onError(err, { kind: 'event', name })`, and each listener is isolated — one throw never stops the others or the message pump.

::: tip Bus vs. events
The bus is **opt-in pub/sub** on a shared topic, with cross-node server-side subscribe. Events (`conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit`) are server-**chosen** pushes — no client opt-in, no server-side subscribe. Both still exist; reach for the bus when you want subscription/membership, events when the server decides who gets pushed.
:::

## Brokerless mesh: ZeroMQ (no broker)

Don't want to run a broker, and don't need the full libp2p stack? [`@super-line/adapter-zeromq`](https://www.npmjs.com/package/@super-line/adapter-zeromq) implements the same `Adapter` contract over plain [ZeroMQ](https://zeromq.org) sockets — the nodes peer directly. Server code is unchanged; only the adapter line differs:

```ts
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'

// mesh: bind a PUB, connect a SUB to every peer (discovery is just addresses, no registry)
const adapter = await createZeroMqAdapter({
  bind: 'tcp://0.0.0.0:9101',
  peers: ['tcp://node-2:9101', 'tcp://node-3:9101'],
})
const srv = createSocketServer(api, { server, authenticate, adapter })
```

It fans out rooms, topics, and the bus the same way, with a gossip-replicated directory backing `srv.cluster.*` / `srv.isOnline` (eventually-consistent, like libp2p — there's no central store). At-most-once delivery, matching the rest of the library. ZeroMQ's `connect` is lazy and auto-reconnecting, so nodes can start in any order. It's **ESM-only** and a **native addon** (Node-only).

For a larger or dynamic fleet, swap mesh for a central **forwarder** — one `npx super-line-zeromq-proxy` process — and point nodes at it:

```ts
const adapter = await createZeroMqAdapter({
  mode: 'proxy',
  frontendUrl: 'tcp://proxy:5557', // node PUBs connect here
  backendUrl: 'tcp://proxy:5558', // node SUBs connect here
})
```

::: tip Which adapter?
**Redis** is the pragmatic default for a backend cluster — simple, central, strong presence. **RabbitMQ** fits teams already running it, or who want the broker to selectively route per channel (gossip-replicated presence, at-most-once). **ZeroMQ mesh** is the lightest way to go broker-less: no extra service, gorgeous at a handful of nodes, but O(N²) connections with a static peer list (use proxy mode, or Redis, for large/dynamic fleets). **libp2p** is the heavyweight decentralized option (NAT traversal, encrypted transports, discovery) for self-hosted / edge deployments. All share one `Adapter` seam, so switching is a one-line change.
:::

The [`react-chat-cluster-zeromq` example](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster-zeromq) is the Redis chat cluster with the broker **deleted** — same app, one fewer service.

## Direct messages

Don't stash a `conn` to DM a user — it's node-local. Put each connection in a **per-user room** and broadcast a shared event to it, which works across nodes:

```ts
onConnection: (conn, ctx) => srv.room(`user:${ctx.user.id}`).add(conn),
// later, from any node:
srv.room(`user:${targetId}`).broadcast('dm', { from, text })
```

## Running it

The [`scaling` example](https://github.com/mertdogar/super-line/tree/main/examples/scaling) boots a real cluster with Docker Compose — Redis, a Caddy load balancer, three server nodes, and six client containers — so you can watch a publish, a room broadcast, and a shared `stats` topic gossiped over the bus fan out across separate processes:

```bash
cd examples/scaling && docker compose up
```

The [`scaling-libp2p` example](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p) is the same cluster with **no broker** — the three nodes peer over libp2p instead of Redis:

```bash
cd examples/scaling-libp2p && docker compose up
```

The [`scaling-rabbitmq` example](https://github.com/mertdogar/super-line/tree/main/examples/scaling-rabbitmq) is the same cluster over **RabbitMQ** — with the management UI exposed so you can watch the exchange, per-node queues, and bindings live:

```bash
cd examples/scaling-rabbitmq && docker compose up
```

For a bus-focused cluster, [`bus-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/bus-cluster) has every node bump a counter and `server.subscribe` to every node's bumps, converging a shared tally — own bumps land in-process via local echo, peers' arrive over Redis.

Next: [React](./react).
