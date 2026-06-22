# Events & rooms

An **event** is a server→client push where the **server picks the recipients**. Declare it under `serverToClient` (no `subscribe` flag):

```ts
serverToClient: {
  message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
}
```

The client listens with `on`, which returns an unsubscribe function:

```ts
const off = client.on('message', (m) => render(m)) // m is typed
off() // stop listening
```

## Sending to one connection

Inside a handler, push to just that connection with `conn.emit`. It's scoped to the connection's role events:

```ts
user: {
  notify: async (_input, _ctx, conn) => {
    conn.emit('message', { room: 'lobby', text: 'hi', from: 'system' })
    return { ok: true }
  },
}
```

`conn.emit` is **node-local** — it only reaches that specific socket on this node. To reach a connection or user *wherever they're connected* (across nodes), use `srv.toConn(id).emit(...)` / `srv.toUser(uid).emit(...)` — see [Introspection & presence](./introspection-and-presence#targeted-send-across-nodes).

## Rooms

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
To push a *role-specific* event to a group, use a [topic](./topics) (`forRole(r).publish`) or iterate and `conn.emit`. `room.broadcast` is deliberately shared-only.
:::

## Direct messages

Don't stash a `conn` to DM a user — it's node-local. Put each connection in a **per-user room** and broadcast a shared event to it, which works across nodes:

```ts
onConnection: (conn, ctx) => srv.room(`user:${ctx.user.id}`).add(conn),
// later, from any node:
srv.room(`user:${targetId}`).broadcast('dm', { from, text })
```

## Event vs topic

Use an **event** when the **server** decides who receives it (notifications, room broadcasts, targeted pushes). Use a [**topic**](./topics) when the **client** opts into a stream. Both are `serverToClient`; the only difference is the `subscribe: true` flag and who initiates.

## Events vs the cluster bus

Events are server-**chosen** pushes (`conn.emit` / `room.broadcast` / `srv.toConn(id).emit` / `srv.toUser(id).emit`) — the recipient gets them with **no opt-in** and there's **no server-side subscribe**. The [cluster bus](./cluster-event-bus) is the opposite: **opt-in** pub/sub on a shared topic, where any node `server.publish`es and both clients (`client.subscribe`) and other servers (`server.subscribe`) choose to listen. They're different tools — reach for an event when the server decides who's pushed to, and the bus when subscribers opt in and you need cross-node, server-side fan-out.

## Delivery

Events are **at-most-once** — a client that's offline misses them (no replay). Design for it: see [Reconnection & delivery](./reconnection-delivery).

Next: [Topics](./topics).
