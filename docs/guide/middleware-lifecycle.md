# Middleware & lifecycle

## Middleware

Middleware runs **before** request and subscribe handlers — for rate-limiting, per-operation authz, logging, and metrics. It's a flat chain: call `next()` to proceed, or `throw` to short-circuit (rejecting the operation).

```ts
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  use: [
    async (ctx, info, next) => {
      rateLimit(info.conn.role, info.name) // throw to reject
      await next()
    },
    async (_ctx, info, next) => {
      const t = Date.now()
      await next()
      metric(info.name, Date.now() - t)    // wrap the handler for timing
    },
  ],
})
```

The `info` argument is `{ kind: 'request' | 'subscribe', name, conn }` — so the same chain can gate both requests and topic subscribes:

```ts
async (_ctx, info, next) => {
  if (info.kind === 'subscribe' && info.name === 'feed') throw new SuperLineError('FORBIDDEN')
  await next()
}
```

Middleware does **not** change `ctx`'s type — it's a cross-cutting gate, not a context transformer. `ctx` is the union of role ctxs; branch on `info.conn.role` if you need to narrow.

## Lifecycle hooks

```ts
createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  onConnection: (conn, ctx) => log('joined', conn.role),
  onDisconnect: (conn, ctx, code) => cleanup(conn),     // code = WebSocket close code
  onError: (err, info) => report(err, info),            // any throw in middleware/handlers
})
```

- **`onConnection`** — once per accepted connection. A handy place to add a connection to a per-user room.
- **`onDisconnect`** — when the socket closes; receives the close `code`.
- **`onError`** — every error thrown in middleware/handlers, *after* the client has been replied to. Great as a test seam and for centralized reporting.

These hooks are also the recommended seams for [testing](./testing) — capture the server-side `conn`, assert connects/disconnects, observe thrown errors.

::: tip One hook, many concerns
`onConnection`/`onDisconnect`/`onError` and `use` are singular here — but a [**plugin**](./plugins) multiplexes them, so any number of independent concerns (metrics, audit, an embedded library) can each register their own without hand-composition. Plugins also add a node-local **tap** (`onEvent`) that observes every request, event, and store write with live payloads.
:::

Next: [Error handling](./errors).
