# Requests

Declare, implement, and call a request — super-line's client→server call that awaits one typed reply. A request declaration carries both an `input` and an `output` schema; the server validates the input, runs your handler, and the client gets back the typed output. For the model behind requests and the other interaction flavors, see [The contract](/concepts/the-contract).

## Declare it on the contract

Put the request under a role's `clientToServer` (or `shared.clientToServer` — see below), with an `input` and `output` schema:

```ts
roles: {
  user: {
    clientToServer: {
      send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
    },
  },
}
```

## Implement the handler

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

## Call it from the client

The client is a typed proxy; call requests as methods:

```ts
const out = await client.send({ room: 'lobby', text: 'hi' })
//    ^? { id: string }
```

### Set a timeout or cancel

Each call accepts per-call options:

```ts
await client.send(input, { timeoutMs: 5000 })          // override the default 30s
await client.send(input, { signal: controller.signal }) // cancel via AbortController
```

A timed-out call rejects with `TIMEOUT`; an aborted call rejects with `BAD_REQUEST`. Set `timeoutMs: 0` to disable the timeout for a call.

## Reject with a typed error

Throw a typed [`SuperLineError`](/how-to/errors) from a handler and the client's promise rejects with the same `code`:

```ts
import { SuperLineError } from '@super-line/core'

send: async ({ room }, ctx) => {
  if (!ctx.canPost(room)) throw new SuperLineError('FORBIDDEN', 'not a member')
  // ...
}
```

Unknown throws become `INTERNAL` (your internals aren't leaked to the client).

## Scope it: shared vs role

Put a request in `shared.clientToServer` to make it callable by **every** role; put it in a role block to scope it. A request a connection's role can't see is rejected with `NOT_FOUND`. See [Roles & auth](/how-to/roles-auth).

Next: [Events & rooms](/how-to/events-rooms).
