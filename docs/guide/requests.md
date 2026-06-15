# Requests

A **request** is a client→server call that awaits one typed reply — super-line's request/response primitive. Declare it under `clientToServer` with an `input` and `output` schema:

```ts
roles: {
  user: {
    clientToServer: {
      send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
    },
  },
}
```

## Server: handle it

Handlers live in `implement`, keyed by role (and `shared`). The handler receives the **validated** input, the connection's `ctx`, and the `conn`:

```ts
srv.implement({
  user: {
    send: async ({ room, text }, ctx, conn) => {
      // input is already validated against the schema
      return { id: crypto.randomUUID() } // typed to the output schema
    },
  },
})
```

The server **always validates inbound input** before your handler runs — bad input rejects with a `VALIDATION` error and the handler never sees it.

## Client: call it

The client is a typed proxy; call requests as methods:

```ts
const out = await client.send({ room: 'lobby', text: 'hi' })
//    ^? { id: string }
```

### Timeouts and cancellation

Each call accepts per-call options:

```ts
await client.send(input, { timeoutMs: 5000 })          // override the default 30s
await client.send(input, { signal: controller.signal }) // cancel via AbortController
```

A timed-out call rejects with `TIMEOUT`; an aborted call rejects with `BAD_REQUEST`. Set `timeoutMs: 0` to disable the timeout for a call.

## Errors

Throw a typed [`SocketError`](./errors) from a handler and the client's promise rejects with the same `code`:

```ts
import { SocketError } from '@super-line/core'

send: async ({ room }, ctx) => {
  if (!ctx.canPost(room)) throw new SocketError('FORBIDDEN', 'not a member')
  // ...
}
```

Unknown throws become `INTERNAL` (your internals aren't leaked to the client).

## Shared vs role requests

Put a request in `shared.clientToServer` to make it callable by **every** role; put it in a role block to scope it. A request a connection's role can't see is rejected with `NOT_FOUND`. See [Roles & auth](./roles-auth).

Next: [Events & rooms](./events-rooms).
