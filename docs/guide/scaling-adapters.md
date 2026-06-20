# Scaling & adapters

A single super-line server uses an in-memory adapter — rooms, topics, and `serverToServer` fan out within that one process. To run **more than one process** (behind a load balancer), give every server a **shared adapter** so fan-out crosses nodes.

## The adapter seam

Rooms, topics, and inter-server events all compile down to channel pub/sub behind the `Adapter` interface. Swap the implementation; the rest of your code is unchanged.

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'

const srv = createSocketServer(api, {
  server, authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'),
})
```

Point every server process at the same Redis. Now `room.broadcast`, `srv.publish` / `forRole(r).publish`, and `srv.emitServer` all reach clients (and peers) on **any** node. At-most-once delivery is preserved.

::: tip No Redis for a single node
You don't need an adapter for one process — the default in-memory adapter handles it. Add Redis only when you scale out.
:::

## serverToServer: coordinate the cluster

Declare node-to-node event payloads at the top level (not role-scoped):

```ts
defineContract({
  roles: { /* … */ },
  serverToServer: {
    rebalance: z.object({ shard: z.number() }),
    cacheInvalidate: z.object({ key: z.string() }),
  },
})
```

Then emit and listen:

```ts
srv.onServer('rebalance', ({ shard }) => moveShard(shard)) // returns an unsubscribe fn
srv.emitServer('rebalance', { shard: 3 })                  // -> every OTHER node
```

`emitServer` **excludes the sender** — it reaches peer nodes only (each server stamps an instance id and drops its own). On a single node it's a no-op. There are no cross-server acks; it's fire-and-forget at-most-once.

## Direct messages

Don't stash a `conn` to DM a user — it's node-local. Put each connection in a **per-user room** and broadcast a shared event to it, which works across nodes:

```ts
onConnection: (conn, ctx) => srv.room(`user:${ctx.user.id}`).add(conn),
// later, from any node:
srv.room(`user:${targetId}`).broadcast('dm', { from, text })
```

## Running it

The [`scaling` example](https://github.com/mertdogar/super-line/tree/main/examples/scaling) boots a real cluster with Docker Compose — Redis, a Caddy load balancer, three server nodes, and six client containers — so you can watch a publish, a room broadcast, and a `serverToServer` event fan out across separate processes:

```bash
cd examples/scaling && docker compose up
```

Next: [React](./react).
