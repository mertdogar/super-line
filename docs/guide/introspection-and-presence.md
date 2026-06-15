# Introspection & presence

super-line gives you two views of who's connected, plus the ability to reach and even **request** any connection across nodes.

- **Local** (`srv.local`) — synchronous, reads only the connections on *this* node.
- **Cluster** (`srv.cluster`) — asynchronous, reads a shared **presence registry** (in-memory for one node, Redis across many).

## Connection metadata

Every connection carries identity and liveness:

```ts
conn.id           // server-assigned unique id (stable for the connection's life)
conn.role         // its role
conn.connectedAt  // Date.now() at the upgrade
conn.lastPongAt   // last heartbeat pong (liveness) — node-local
conn.lastPingAt   // last heartbeat ping sent
```

## Local introspection (sync)

```ts
srv.nodeId                       // this process's stable id
srv.local.connections            // Conn[] on this node
srv.local.rooms                  // room names with members here
srv.local.topics                 // topic names with subscribers here
srv.room('lobby').connections    // members of a room (this node)
srv.room('lobby').size           // member count (this node)
```

Everything else is plain JavaScript — filter the array:

```ts
srv.local.connections.filter((c) => c.role === 'user')
srv.local.connections.find((c) => c.id === someId)
const stale = srv.local.connections.filter((c) => Date.now() - (c.lastPongAt ?? 0) > 60_000)
```

## Heartbeat

One timer pings every connection (default every 30s), updating `lastPingAt`/`lastPongAt`. Optionally **reap** dead sockets:

```ts
createSocketServer(api, {
  server,
  authenticate,
  heartbeat: { interval: 30_000, maxMissed: 2 }, // terminate after 2 missed pongs (fires onDisconnect)
})
// heartbeat: false   // disable entirely
```

A reaped connection is `terminate()`d and flows through `onDisconnect` like any other drop.

## Cluster introspection (async)

The cluster view reads the **presence registry**. To make connections identifiable across nodes, give the server an `identify` hook (a stable user key) and, optionally, a `describeConn` projector for extra fields. `ctx` is **never** auto-serialized.

```ts
createSocketServer(api, {
  server,
  authenticate,
  identify: (conn) => conn.ctx.userId,          // powers byUser / isOnline / toUser
  describeConn: (conn) => ({ plan: conn.ctx.plan }), // extra descriptor fields
})

await srv.cluster.count()           // total connections cluster-wide
await srv.cluster.connections()     // ConnDescriptor[] across all nodes
await srv.cluster.byUser('u42')     // that user's connections (any node)
await srv.cluster.room('lobby')     // members of a room across nodes
await srv.cluster.topology()        // [{ nodeId, connections, rooms, alive }]
await srv.isOnline('u42')           // is this user connected anywhere?
```

A `ConnDescriptor` is a **serializable snapshot** (not a live `Conn`): `{ id, role, nodeId, connectedAt, userId?, rooms, ...describeConn }`. It's taken at connect, so seed any descriptor fields in `onConnection` (which runs just before the snapshot). Live-updating values like `lastPongAt` stay node-local and are **not** in the registry.

::: tip Requires a presence-capable adapter
The in-memory and Redis adapters both implement presence. `srv.cluster.*` throws a clear error on an adapter that doesn't. Liveness is tracked by a per-node key with a TTL refreshed by the heartbeat, so a **crashed** node's connections drop out of cluster queries automatically; a graceful `close()` removes them immediately.
:::

## Targeted send across nodes

Reach a specific connection or user no matter which node holds them — no registry lookup on the delivery path:

```ts
srv.toConn(id).emit('notice', { text: 'hi' })   // one connection, any node
srv.toUser('u42').emit('notice', { text: 'hi' }) // every device of a user, any node

srv.toConn(id).close()       // kick one connection (any node)
srv.toUser('u42').disconnect() // kick all of a user's connections
```

`emit` here takes **shared** events (the vocabulary every role understands), like `room.broadcast`. This is the cross-node answer to node-local `conn.emit`.

## Server → client requests

A connection can be **asked** a typed question. Declare a `serverToClient` entry with `input` + `output` — a third flavor alongside events and topics:

```ts
shared: {
  serverToClient: {
    confirm: { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
}
```

The client answers with `implement` (throw a `SocketError` for a typed failure):

```ts
client.implement({
  confirm: async ({ q }) => ({ ok: q === 'ready?' }),
})
```

The server awaits the reply — across nodes — with `toConn(id).request`:

```ts
const answer = await srv.toConn(id).request('confirm', { q: 'ready?' }, { timeout: 5_000 })
answer.ok // boolean, typed
```

`request` is offered on `toConn` only (a single, unambiguous target) and is typed to **shared** server requests — the caller has an id, not a role. If no live node owns the id, or the client doesn't answer in time, it rejects with a `TIMEOUT` `SocketError`. To request a *user*, pick a connection first: `const [c] = await srv.cluster.byUser(uid); await srv.toConn(c.id).request(...)`.

## Per-connection state

Need mutable scratch state on a connection? Declare a `data` schema in a role block; `conn.data` is typed per role and starts `{}`:

```ts
roles: {
  user: {
    data: z.object({ lastSeenMsgId: z.number() }),
    clientToServer: { ack: { input: z.object({ id: z.number() }), output: z.object({}) } },
  },
}

srv.implement({
  user: {
    ack: async ({ id }, _ctx, conn) => {
      conn.data.lastSeenMsgId = id // typed
      return {}
    },
  },
})
```

## Backpressure

Guard nodes against slow consumers:

```ts
createSocketServer(api, {
  server,
  authenticate,
  backpressure: { maxBufferedBytes: 8 * 1024 * 1024, onExceed: 'close' }, // or 'drop'
})
```

When a connection's `ws.bufferedAmount` exceeds the limit, `'close'` (default) drops it with code `1013`; `'drop'` skips the frame (logged, never silent).

Next: [Scaling & adapters](./scaling-adapters).
