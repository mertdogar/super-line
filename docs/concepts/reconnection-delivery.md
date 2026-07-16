# Reconnection & delivery

The client is resilient by default — it reconnects, re-subscribes, and queues calls across a drop without your help. But underneath that resilience the delivery model is deliberately **at-most-once**: a message sent while a client is offline is gone, not replayed. Understanding what survives a drop — and what doesn't — is the difference between a realtime app that self-heals and one that quietly loses state.

## What survives a drop

When the socket falls over, the client restores itself along a few axes automatically:

- **Auto-reconnect** with exponential backoff + full jitter. The schedule is governed by `reconnectBaseMs` (500), `reconnectMaxMs` (30000), and `reconnectFactor` (2); set `reconnect: false` to opt out entirely.
- **Topics re-subscribe on their own.** A topic subscription is *client-controlled* state, so the client replays it after every reconnect — you never re-call `subscribe`.
- **Collection subscriptions and open documents re-subscribe too**, on the same principle. The re-subscribe is answered with a **full snapshot** from the durable store, which the client diffs against the rows it already held and emits as ordinary insert/update/delete events. So rows written *while you were offline* do arrive after reconnect — a collection is durable state, not a live feed you can miss. This is the one place the at-most-once rule below doesn't bite.
- **In-flight requests reject** with `DISCONNECTED` the moment the socket drops. They are not retried for you.
- **Calls made *while* reconnecting are queued** and flushed once the link is back, so application code doesn't have to gate every call on connection state.

```ts
import { webSocketClientTransport } from '@super-line/transport-websocket'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }), role: 'user',
  reconnect: true, reconnectBaseMs: 500, reconnectMaxMs: 30_000, reconnectFactor: 2,
})
```

The backoff math is exported as a pure function, `backoffDelay(attempt, opts)`, if you want to reuse or test the same schedule elsewhere.

## When a re-subscribe fails

A replayed subscription can be *rejected*, and this is the one reconnect failure you have to handle yourself. The read policy is re-evaluated on **every** (re)subscribe, so a principal who lost authorization during the outage gets `FORBIDDEN` on the way back; a slow server can produce `TIMEOUT`. Either way `ready` resolved long ago, on the first subscribe — it cannot reject twice — so the failure surfaces on the client's `onError` sink instead:

```ts
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }), role: 'user',
  onError: (error, info) => {
    if (info.kind === 'resubscribe') {
      // info.collection (+ info.id for a CRDT doc) identifies what went dead.
      console.error(`lost ${info.collection}`, error)
    }
  },
})
```

Treat a `resubscribe` error as **that subscription being dead**: the failure itself triggers no retry, and nothing re-attempts it until the next transport reopen. The subscription stays registered, so a *later* drop-and-reconnect would replay it — but nothing forces one, and until then the handle looks healthy while receiving nothing. For a long-lived process this is the failure worth being loud about: `client.connected` is still `true` and the rows simply stop. Resubscribe explicitly, or fail the process and let it restart. (With no `onError` sink the client logs the failure rather than swallowing it.)

## Client-controlled vs server-controlled state

The asymmetry above — topics restore, rooms don't — isn't an accident, it's the model. super-line is [server-authoritative](/concepts/server-authoritative), and live state falls into two camps:

- **Client-controlled** state (topic subscriptions) is something the client declared and can re-declare. The client remembers it and replays it on reconnect.
- **Server-controlled** state (room membership, presence, any join flow a handler ran) lives on the server and was decided by *server* logic — an authorization check, a side effect, a write. The client can't safely reconstruct it, so it doesn't try. After a reconnect you re-run the request that established it.

The rule of thumb: if *you* subscribed to it, it comes back for free; if a *handler* put you somewhere, you re-ask.

## At-most-once, and what it asks of you

Messages sent while a client is offline are **not replayed**. That is the right default for the traffic realtime systems actually carry — cursors, presence, live prices — where stale state is worse than missed state: replaying a minute of old cursor positions is noise, not recovery. The consequence is a small set of design obligations:

- **Make handlers idempotent.** A client may re-issue a request after reconnecting; the same request arriving twice must not double-charge, double-post, or double-increment.
- **Re-run join flows after reconnect.** Rooms and any server-side setup are not auto-restored — re-call the `join` request ([Events & rooms](/how-to/events-rooms)) when the connection returns. Topics, being client-controlled, come back on their own ([Topics](/how-to/topics)).
- **Decide retry per call.** In-flight requests reject `DISCONNECTED` rather than silently surviving the gap; whether to retry is a per-call judgement, not a global one.

## Ordering and the reconnect boundary

Over a single live connection, delivery is **ordered and reliable** — the underlying transport (a WebSocket over TCP by default) does not reorder or drop frames mid-stream. The only place the guarantee weakens is the reconnect boundary: a drop is a **gap** (messages published while you were away are missing), never a reorder and never a wire-level duplicate. Any duplicate you observe is an *application-level* retry — which is exactly why idempotency, not de-duplication, is the tool that makes this safe.

Session resume and server-push replay are **not built** — there is no log the client rejoins to fill the gap. See the project status in the README.

## The 401-looks-like-a-drop caveat

Over the WebSocket transport, a rejected upgrade — bad credentials, a failed `authenticate` — is indistinguishable on the wire from any other drop. A client with bad credentials and `reconnect: true` therefore **retries forever**, because from its side an auth rejection and a flaky network look identical. When you want an auth failure to surface immediately — tests, a login screen — turn reconnect off so the first rejection propagates:

```ts
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }), role: 'user', params: { token: 'bad' }, reconnect: false,
})
await client.whoami({}) // rejects DISCONNECTED right away instead of retrying
```

This is a property of the WebSocket handshake, not of super-line's auth model — other [transports](/concepts/transports-and-adapters) surface rejection differently.

---

For catching and handling the `DISCONNECTED` rejection itself, see [Errors](/how-to/errors); for what actually crosses the wire, [Serialization](/how-to/serialization).
