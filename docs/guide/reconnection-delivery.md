# Reconnection & delivery

The client is resilient by default — but the delivery model is **at-most-once**, and designing for that is the key to correct realtime apps.

## What the client does automatically

- **Auto-reconnect** with exponential backoff + full jitter. Configurable via `reconnectBaseMs` (500), `reconnectMaxMs` (30000), `reconnectFactor` (2); set `reconnect: false` to disable.
- **Topics auto re-subscribe** on reconnect — you don't re-call `subscribe`.
- **In-flight requests reject** with `DISCONNECTED` when the socket drops.
- **Calls made *while* reconnecting are queued** and flushed once the connection is back.

```ts
const client = createSuperLineClient(api, {
  url, role: 'user',
  reconnect: true, reconnectBaseMs: 500, reconnectMaxMs: 30_000, reconnectFactor: 2,
})
```

The backoff math is exported as a pure function, `backoffDelay(attempt, opts)`, if you want to reuse or test it.

## At-most-once delivery

Messages sent while a client is offline are **not replayed**. This is the right default for cursors, presence, and live prices — stale state is worse than missed state. It means you should:

- **Make handlers idempotent.** A client may retry after a reconnect; the same request arriving twice shouldn't double-charge.
- **Re-run join flows after reconnect.** Rooms are *server-controlled*, so they aren't auto-restored — re-call your `join` request when the connection comes back. (Topics, which are *client-controlled*, do auto re-subscribe.)
- **Don't assume in-flight requests survive a drop.** They reject `DISCONNECTED`; decide per call whether to retry.

Session resume/replay is not built yet — see the project status in the README.

## The 401-looks-like-a-drop caveat

Over the WebSocket API, a rejected upgrade (e.g. bad credentials) is indistinguishable from any other drop. So a client with bad credentials and `reconnect: true` will **retry forever**. When you want an auth failure to surface immediately (tests, login flows), set `reconnect: false`:

```ts
const client = createSuperLineClient(api, { url, role: 'user', params: { token: 'bad' }, reconnect: false })
await client.whoami({}) // rejects DISCONNECTED right away instead of retrying
```

Next: [Serialization](./serialization).
