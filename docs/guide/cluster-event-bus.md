# The cluster event bus

A **shared topic** doubles as a symmetric, cluster-wide pub/sub bus — no extra API. One declaration types all three of its subscribers at once: server-side listeners, client-side subscribers, and the publish itself.

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

- **same-node `server.subscribe` listeners** — fire directly, in-process, no Redis/WS hop;
- **other nodes' `server.subscribe` listeners** — fire via the [adapter](./scaling-adapters) (inbound-validated);
- **subscribed clients on any node** — receive over WS with the unchanged `client.subscribe`.

## Server: subscribe

`server.subscribe` is the server-side, cluster-wide consumer. It fires for a publish from **any** node — including this one (a **local echo**, delivered in-process with no Redis/WS round-trip). The callback gets `(data, { from })`, where `from` is the origin node id, and it returns an unsubscribe fn:

```ts
const off = srv.subscribe('announce', (data, { from }) => {
  if (from === srv.nodeId) return // self-exclude your own publishes
  applyAnnounce(data)             // converge cluster state
})
off() // unsubscribe
```

`data` is typed from the same shared `serverToClient` declaration the client subscribes to. `server.subscribe` is **shared topics only** — role-scoped server-side subscribe is deferred.

## Publish from any node

`server.publish` is the same `srv.publish` you already use on shared topics — any node may publish, and every subscriber (server-side and client-side, on every node) sees it:

```ts
srv.publish('announce', { msg: 'maintenance at 5pm' }) // shared topic → the bus
```

So one `server.publish` delivers to (1) **same-node** `server.subscribe` listeners in-process, (2) **other nodes'** `server.subscribe` listeners via the adapter, and (3) **subscribed clients** on any node over WS. Role topics still use `srv.forRole(r).publish(...)` and reach that role's **client** subscribers only.

## Validation & isolation

Inbound events from **other** nodes are validated against the topic's payload schema; the local echo is trusted (not re-validated). A throwing listener or a bad inbound payload routes to `opts.onError(err, { kind: 'event', name })`, and each listener is **isolated** — one throw never stops the others or the message pump.

::: tip Bus vs. events
The bus is **opt-in** pub/sub on a shared topic, with cross-node server-side subscribe. [Events](./events-rooms) (`conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit`) are server-**chosen** pushes — no client opt-in, no server-side subscribe. Both exist; reach for the bus when subscribers opt in, events when the server decides who gets pushed.
:::

## Running it

The [`event-bus` example](https://github.com/mertdogar/super-line/tree/main/examples/event-bus) shows the bus in a single process — a `server.publish` fans out to several in-process `server.subscribe` listeners (local echo, no round-trip) plus one client subscriber over WS, no Redis needed. The [`bus-cluster` example](https://github.com/mertdogar/super-line/tree/main/examples/bus-cluster) scales it to three nodes that converge a shared tally — own bumps land in-process via local echo, peers' arrive over the adapter.

Next: [Roles & auth](./roles-auth).
