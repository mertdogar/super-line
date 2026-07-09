# Events & rooms

Push a server-chosen message to one connection, or broadcast a shared event to a server-owned room. Both are declared under `serverToClient` (no `subscribe` flag) — the difference from a [topic](/how-to/topics) is that here the **server** picks the recipients, with no client opt-in. For where events sit among super-line's interaction flavors, see [The contract](/concepts/the-contract).

## Declare an event

Declare it under `serverToClient` with a `payload` schema:

```ts
serverToClient: {
  message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
}
```

## Listen on the client

The client listens with `on`, which returns an unsubscribe function:

```ts
const off = client.on('message', (m) => render(m)) // m is typed
off() // stop listening
```

## Send to one connection

Inside a handler, push to just that connection with `conn.emit`. It's scoped to the connection's role events:

```ts
user: {
  notify: async (_input, _ctx, conn) => {
    conn.emit('message', { room: 'lobby', text: 'hi', from: 'system' })
    return { ok: true }
  },
}
```

`conn.emit` is **node-local** — it only reaches that specific socket on this node. To reach a connection or user *wherever they're connected* (across nodes), use `srv.toConn(id).emit(...)` / `srv.toUser(uid).emit(...)` — see [Introspection & presence](/how-to/introspection-and-presence#targeted-send-across-nodes).

## Broadcast to a room

A **room** is a server-controlled group of connections. Add members, then broadcast:

```ts
srv.room('room:42').add(conn)                       // server-controlled membership
srv.room('room:42').broadcast('message', { ... })   // delivered to every member
srv.room('room:42').remove(conn)
srv.room('room:42').size                            // member count on THIS node
```

Rooms are **mixed-role** — a `user` and an `agent` can be in the same room. Because of that, `broadcast` only accepts **shared events** (the vocabulary every member provably understands). So put events you broadcast to rooms in `shared.serverToClient`:

```ts
shared: {
  serverToClient: { message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) } },
}
```

::: tip Role-specific fan-out
To push a *role-specific* event to a group, use a [topic](/how-to/topics) (`forRole(r).publish`) or iterate and `conn.emit`. `room.broadcast` is deliberately shared-only.
:::

## DM a user across nodes

Don't stash a `conn` to DM a user — it's node-local. Put each connection in a **per-user room** and broadcast a shared event to it, which works across nodes:

```ts
onConnection: (conn, ctx) => srv.room(`user:${ctx.user.id}`).add(conn),
// later, from any node:
srv.room(`user:${targetId}`).broadcast('dm', { from, text })
```

## Event, topic, or the bus?

Reach for an **event** when the **server** decides who receives it (notifications, room broadcasts, targeted pushes). Reach for a [**topic**](/how-to/topics) when the **client** opts into a stream — both are `serverToClient`; the only difference is the `subscribe: true` flag and who initiates. Reach for the [**cluster event bus**](/how-to/cluster-event-bus) when subscribers opt in *and* you need cross-node, server-side fan-out. The [contract concepts page](/concepts/the-contract) lays out how the flavors relate.

## Design for at-most-once delivery

Events are **at-most-once** — a client that's offline misses them (no replay). Design for it: see [Reconnection & delivery](/concepts/reconnection-delivery).

Next: [Topics](/how-to/topics).
