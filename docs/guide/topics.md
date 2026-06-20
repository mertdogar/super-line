# Topics

A **topic** is a server→client stream the **client opts into**. Declare it as a `serverToClient` entry with `subscribe: true`:

```ts
serverToClient: {
  prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
}
```

## Client: subscribe

```ts
const sub = client.subscribe('prices', (p) => render(p)) // p is typed
await sub.ready        // resolves when the server accepts; rejects if denied/disconnected
sub.unsubscribe()
```

`subscribe` returns immediately with a `Subscription`. Await `.ready` if you need to know the subscription was accepted — it **rejects** with `FORBIDDEN` if `authorizeSubscribe` denies it, or `DISCONNECTED` if the socket drops first. On reconnect, topics **auto re-subscribe**.

## Server: publish

Topics are **server-publish only** — clients cannot publish. Publish from anywhere on the server:

```ts
srv.forRole('user').publish('prices', { symbol: 'AAPL', price: 192.3 }) // role topic
srv.publish('announce', { msg: 'maintenance at 5pm' })                  // shared topic
```

- A topic in a **role** block is published with `srv.forRole(role).publish(...)` and reaches that role's subscribers.
- A topic in the **shared** block is published with `srv.publish(...)` and reaches every role's subscribers.

## Authorizing subscriptions

Gate private topics with `authorizeSubscribe` — return `false` or throw to deny (the client's `.ready` rejects `FORBIDDEN`):

```ts
const srv = createSuperLineServer(api, {
  server, authenticate,
  authorizeSubscribe: async (topic, ctx, conn) => {
    if (topic.startsWith('org:')) return ctx.user.orgs.includes(topic.slice(4))
    return true
  },
})
```

Subscribing to a topic that isn't on the connection's role surface is rejected with `NOT_FOUND`.

## Client → others

Clients can't publish — that's by design. To let a client fan something out, send a **request**; the handler validates/authorizes, then publishes:

```ts
srv.implement({
  user: {
    setPrice: async ({ symbol, price }, ctx) => {
      if (!ctx.user.canTrade) throw new SuperLineError('FORBIDDEN')
      srv.forRole('user').publish('prices', { symbol, price })
      return { ok: true }
    },
  },
})
```

## The cluster bus

A **shared topic** is also a symmetric, cluster-wide pub/sub bus built on the existing topic substrate. One `server.publish` fans out to **three** kinds of subscriber at once:

- **same-node `server.subscribe` listeners** — fire directly, in-process, no Redis/WS hop;
- **other nodes' `server.subscribe` listeners** — fire via the adapter (inbound-validated);
- **subscribed clients on any node** — receive over WS.

### Server: subscribe

`server.subscribe` is the server-side, cluster-wide consumer. It fires for a publish from **any** node — including this one (a **local echo**, delivered in-process with no Redis/WS round-trip). The callback gets `(data, { from })`, where `from` is the origin node id:

```ts
const off = srv.subscribe('announce', (data, { from }) => {
  if (from === srv.nodeId) return        // self-exclude your own publishes
  console.log('from peer', from, data.msg)
})
off() // unsubscribe
```

`data` is typed from the same shared `serverToClient` declaration the client subscribes to. `server.subscribe` is **shared topics only** — role-scoped server-side subscribe is deferred.

Inbound events from **other** nodes are validated against the topic's payload schema; the local echo is trusted (not re-validated). A throwing listener or a bad inbound payload routes to `opts.onError(err, { kind: 'event', name })`, and each listener is **isolated** — one throw never stops the others or the message pump.

### Publish from any node

`server.publish` is the same `srv.publish` you already use on shared topics — any node may publish, and every subscriber (server-side and client-side, on every node) sees it:

```ts
srv.publish('announce', { msg: 'maintenance at 5pm' }) // shared topic → the bus
```

Role topics still use `srv.forRole(r).publish(...)` and reach that role's **client** subscribers only.

## Parameterized topics

Topics are typed by **exact contract key**. Parameterized names like `room:{id}` aren't type-inferred yet — use a concrete key and carry the id in the payload (filter client-side), or use a [room](./events-rooms) for server-controlled grouping.

Next: [Roles & auth](./roles-auth).
