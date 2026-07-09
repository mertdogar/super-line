# Topics

Declare a subscribable stream and subscribe to it from the client. A **topic** is a `serverToClient` entry that the **client opts into** — the server is the only publisher, and clients choose whether to listen. For how topics differ from events and the other interaction flavors, see [The contract](/concepts/the-contract).

## Declare a topic

Add `subscribe: true` to a `serverToClient` entry:

```ts
serverToClient: {
  prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
}
```

## Subscribe from the client

```ts
const sub = client.subscribe('prices', (p) => render(p)) // p is typed
await sub.ready        // resolves when the server accepts; rejects if denied/disconnected
sub.unsubscribe()
```

`subscribe` returns immediately with a `Subscription`. **Await `sub.ready`** if you need to know the subscription was accepted — it **rejects** with `FORBIDDEN` if `authorizeSubscribe` denies it, or `DISCONNECTED` if the socket drops first. On reconnect, topics **auto re-subscribe**.

## Publish from the server

Topics are **server-publish only** — clients cannot publish. Publish from anywhere on the server:

```ts
srv.forRole('user').publish('prices', { symbol: 'AAPL', price: 192.3 }) // role topic
srv.publish('announce', { msg: 'maintenance at 5pm' })                  // shared topic
```

- A topic in a **role** block is published with `srv.forRole(role).publish(...)` and reaches that role's subscribers.
- A topic in the **shared** block is published with `srv.publish(...)` and reaches every role's subscribers.

## Authorize subscriptions

Gate private topics with `authorizeSubscribe` — return `false` or throw to deny (the client's `.ready` rejects `FORBIDDEN`):

```ts
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate,
  authorizeSubscribe: async (topic, ctx, conn) => {
    if (topic.startsWith('org:')) return ctx.user.orgs.includes(topic.slice(4))
    return true
  },
})
```

Subscribing to a topic that isn't on the connection's role surface is rejected with `NOT_FOUND`.

## Let a client fan something out

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

## Subscribe from other servers too

A shared topic is also a symmetric, **cluster-wide pub/sub bus** — any node `server.publish`es, and both clients (`client.subscribe`) and other servers (`server.subscribe`, in-process and cluster-wide, with local echo) listen. It's a feature in its own right: see [The cluster event bus](/how-to/cluster-event-bus).

## Parameterized topics

Topics are typed by **exact contract key**. Parameterized names like `room:{id}` aren't type-inferred yet — use a concrete key and carry the id in the payload (filter client-side), or use a [room](/how-to/events-rooms) for server-controlled grouping.

Next: [The cluster event bus](/how-to/cluster-event-bus).
