# Scaling & adapters

A single super-line server uses an in-memory adapter — rooms and topics fan out within that one process. To run **more than one process** (behind a load balancer), give every server a **shared adapter** so fan-out crosses nodes.

## The adapter seam

Rooms and topics all compile down to channel pub/sub behind the `Adapter` interface. Swap the implementation; the rest of your code is unchanged.

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'

const srv = createSocketServer(api, {
  server, authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'),
})
```

Point every server process at the same Redis. Now `room.broadcast`, `srv.publish` / `forRole(r).publish`, and the cluster event bus all reach clients (and peers) on **any** node. At-most-once delivery is preserved.

::: tip No Redis for a single node
You don't need an adapter for one process — the default in-memory adapter handles it. Add Redis only when you scale out.
:::

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

For a bus-focused cluster, [`bus-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/bus-cluster) has every node bump a counter and `server.subscribe` to every node's bumps, converging a shared tally — own bumps land in-process via local echo, peers' arrive over Redis.

Next: [React](./react).
