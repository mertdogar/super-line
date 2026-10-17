# Hibernation & resumption

On most hosts a super-line server is a long-lived process. It starts once, and every connection, subscription, and room lives in its memory until the process stops. A Cloudflare Durable Object breaks that assumption: the object leaves memory whenever it's idle and comes back on the next event, while its clients' sockets stay open the whole time. This page explains how a node survives that without its clients noticing, and what the design costs. For the steps to deploy one, see [Host a node on Cloudflare Durable Objects](/how-to/cloudflare-durable-objects).

## One object is one node

A super-line server holds state for every connection: who it authenticated as, which topics, collections, and documents it subscribed to, and which rooms it joined. A stateless Worker forgets everything between requests, so it can't host a node. A Durable Object can. It's a single instance with a stable identity and its own SQLite storage, and every request for its name reaches that same object.

So one object is one node. Two objects share nothing: no adapter carries rooms, topics, or the cluster event bus between them, and a per-tenant object is a separate node with separate state.

## The socket outlives the instance

An object hibernates after about ten seconds with nothing pending. Cloudflare discards the instance (its memory, its closures, and the server object itself) but keeps its WebSocket connections open, so clients see nothing. The next event constructs a fresh instance. The class constructor runs again, which means your server factory runs again, and only then does the event reach the new server.

That splits one lifetime into two:

| | Lives until |
| --- | --- |
| A client's socket | the client closes it, or a deploy restarts the object |
| The server instance | the next idle period, often seconds away |

A server on Node never holds a socket whose connection it has forgotten. A node in a Durable Object holds one after every idle period, for every connected client. Resumption is how the new instance remembers them.

## A connection is rebuilt from its snapshot

The obvious way to remember would be to save the server's internal registries: channel membership, row subscription filters, open documents. Those are derived state, though. Each entry exists because the client sent a frame, so the frames are what's worth keeping. A connection's real inputs are few:

- the outcome of `authenticate`: role, `ctx`, `env`, and the connection id
- the time it connected
- the rooms a handler joined it to, which no client frame reproduces
- the subscribes it sent that are still live (topics, collection subscriptions, and open documents), net of their unsubscribes

That list is the **connection snapshot**. The server keeps it current as frames arrive. A subscribe is recorded once it succeeds, and a refused one never is. Each change goes to the transport, and the Cloudflare transport writes it to the object's SQLite, one row per connection. The socket itself carries only the connection id. A socket's attachment holds 16 KiB, and a dashboard that subscribes to many collections can outgrow that.

On a wake, the transport walks the surviving sockets, reads each one's snapshot, and hands both to the new server. The server accepts the socket as it would a fresh connection, keeping the original `connectedAt`, re-adds its rooms, and **replays** each stored subscribe through the ordinary handlers. The replies are muted: the client already holds that subscription, so it receives nothing and carries on. `server.ready` resolves only once every surviving socket is back, and `createDurableNode` holds incoming events until then, so the event that woke the object never meets a half-rebuilt connection.

A reconnect works differently. After a dropped socket, a re-subscribe receives a full snapshot of rows or document state, because anything could have changed during the outage. A replay sends no snapshot. A single object can't change while it hibernates, since nothing in it runs, so the client's view is still current.

Anything outside the snapshot is lost on a wake:

- **Everything in memory**: module state, caches, and timers (none can be pending, since a timer prevents hibernation).
- **`conn.data`**, the untyped per-connection scratch space. `onConnection` runs again for every resumed socket, so it can seed `conn.data` again. That also means its side effects must tolerate running twice.
- **Types JSON can't carry.** The snapshot is stored as JSON, so a `Date` in `ctx` comes back as a string.

A socket whose snapshot is missing (rare, for example when a deploy races a connect) is closed with code `4409`, and the client reconnects as it would after any drop. Forced reconnection is the fallback, never the plan: closing every socket on every wake would turn each idle period into a visible disconnect.

## Why a subscription can end with the socket open

Replay runs each subscribe through its ordinary handler, so read policies run again. Usually they allow it. But a principal may have lost access while the node slept, or a collection may have been removed or a document deleted, and then the replay is refused.

Muting the refusal would leave the client believing it's subscribed, waiting for rows that never come. Instead, the server ends that one subscription with an `end` frame, and the client reports it on `onError` with `kind: 'resubscribe'`, just like a re-subscribe that fails after a reconnect. See [When a re-subscribe fails](/concepts/reconnection-delivery#when-a-re-subscribe-fails).

This is the only place in super-line where a subscription ends while its socket stays open. On every other host, a subscription ends with its socket.

## Liveness moves to the transport

A server on Node pings every connection on a timer and drops the ones that stop answering. A Durable Object can't run that timer: an object never hibernates while a timer is pending, so one heartbeat would keep the node awake for as long as anyone is connected. Moving the ping onto a Durable Object alarm doesn't help either, because waking the object on every interval is exactly the cost hibernation exists to avoid.

So the Cloudflare transport declares that the socket owns liveness, and the server starts no heartbeat. Liveness moves to the two parts that stay running while the node sleeps:

- **The client.** Its `keepalive` option sends a ping every N milliseconds and drops the socket when no reply arrives before the next ping.
- **Cloudflare.** It answers that ping itself with a fixed auto-response, without waking the object.

The auto-response matches the exact text of a JSON ping. With a custom serializer the pings reach the server and wake the object. That's still correct, just not free.

The trade-off is that the server no longer hears from its clients between events. `conn.lastPongAt` never advances, and plugin-auth's `lastSeenAt` isn't refreshed while a session is open, so "seen in the last 90 seconds" no longer means "online". On this host an open session is the online signal. A client that vanishes without closing its socket reads as online until Cloudflare reports the socket closed. [Presence on a hibernating node](/how-to/cloudflare-durable-objects#presence-on-a-hibernating-node) shows how to read it.

## An awake node is billed

An object is billed for the time it spends in memory, so whatever keeps it awake costs money. The rule is simple: an object hibernates only when nothing is pending, meaning no timer, no request in flight, and no event being handled.

Most of super-line's work fits that rule, because a request is handled and done. A few things deliberately don't:

- **A streaming chat message** lives in memory across many events, and hibernating mid-stream would cut it off. plugin-chat takes a **busy token** for the stream with [`ctx.hold()`](/concepts/plugins#plugin-private-cluster-channels) and releases it when the stream settles. The token is a pending timer, so the node stays awake.
- **A CRDT edit** reaches storage 250 ms later, so a burst of keystrokes costs one write. The pending write keeps the object awake for that window, so hibernation never loses an edit.
- **plugin-queue** polls on an interval, so a node running queues never hibernates.
- **Any request** the object receives wakes it, which is why only the socket path should reach the node.

A busy token buys idle tolerance, not a guarantee. Cloudflare evicts an object that receives no event for roughly 70–140 seconds, even while a timer is pending, so a stream that goes quiet for that long is lost with the instance that held it. super-line doesn't store plugin state in the snapshot today, so a held stream can't be resumed on a new instance.

## What the design gives up

Transparent resumption rests on one fact: a single object that's asleep can't change. That fact sets the boundaries of this host:

- **No clustering across objects.** With two nodes, one could change state while the other slept, so a replay would have to re-send snapshots and could no longer stay silent. Objects stay independent nodes with no adapter between them.
- **WebSocket only.** Durable Objects let a WebSocket hibernate, but not an HTTP stream, so SSE and long-poll have no hibernation story here.
- **Queues keep the node awake.** Moving the queue scheduler onto Durable Object alarms would be a redesign.
- **A deploy still disconnects.** A deploy restarts every object and closes its sockets. Clients reconnect and re-subscribe through the ordinary [reconnect path](/concepts/reconnection-delivery), with full snapshots, so a deploy looks like a brief outage.

## Next steps

- [Host a node on Cloudflare Durable Objects](/how-to/cloudflare-durable-objects): configure, deploy, and debug a node.
- [Reconnection & delivery](/concepts/reconnection-delivery): what a reconnect restores, and the `keepalive` option.
- [Transports and adapters](/concepts/transports-and-adapters): why a transport can change where a server runs.
- [Plugins](/concepts/plugins): `hold()` and the rest of the plugin context.
